import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), owned: vi.fn(), get: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.auth }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: mocks.owned }) }) } }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  getAudiobookObjectBuffer: mocks.get, putAudiobookObject: mocks.put,
  isMissingBlobError: (error: unknown) => error instanceof Error && error.message === 'missing',
}));

import { GET } from '@/app/api/audiobook/director-diagnostics/route';
import { saveDramaTtsDiagnostic } from '@/lib/server/audiobooks/drama-tts-diagnostics';
import { categorizeErrors } from '@/lib/shared/audiobook-error-category';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: 'owner' });
  mocks.owned.mockResolvedValue([{ id: 'book' }]);
  mocks.get.mockResolvedValue(Buffer.from('{"schemaVersion":1}'));
  mocks.put.mockResolvedValue(undefined);
});

const request = (query: string) => new NextRequest(`http://localhost/api/audiobook/director-diagnostics?bookId=book&${query}`);

describe('Drama diagnostic downloads', () => {
  it('recognizes the reported text mismatch and artifact evidence independently', () => {
    expect(categorizeErrors(['Segment text does not exactly match the authoritative source.']).category).toBe('drama_director');
    expect(categorizeErrors(['Unrecognized failure'], null, true).category).toBe('drama_director');
    expect(categorizeErrors(['Unrecognized failure']).category).toBe('general');
  });

  it('downloads the existing Director artifact for chapter zero', async () => {
    const response = await GET(request('chapterIndex=0'));
    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith('book', 'owner', 'drama-director-failure-chapter-0000.json', null);
    expect(response.headers.get('Content-Disposition')).toContain('attachment;');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('downloads the TTS diagnostic using its one-based storage prefix', async () => {
    expect((await GET(request('chapterIndex=1&kind=provider'))).status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith('book', 'owner', '0002__provider_failure.json', null);
  });

  it('rejects missing indices and invalid diagnostic kinds', async () => {
    expect((await GET(request('kind=director'))).status).toBe(400);
    expect((await GET(request('chapterIndex=0&kind=other'))).status).toBe(400);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('checks ownership before retrieving diagnostic data', async () => {
    mocks.owned.mockResolvedValue([]);
    expect((await GET(request('chapterIndex=0'))).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing artifact', async () => {
    mocks.get.mockRejectedValue(new Error('missing'));
    expect((await GET(request('chapterIndex=0'))).status).toBe(404);
  });

  it('persists structured synthesis failures without copying extra upstream fields', async () => {
    const flag = { kind: 'cloud-tts-failed' as const, speaker: 'Hero', sourceText: 'Hello.', chunkIndex: 0, attempts: 2, reason: 'GeminiTtsInputError', extra: 'private provider payload' };
    await saveDramaTtsDiagnostic({ bookId: 'book', userId: 'owner', chapterIndex: 1, flags: [flag] });
    const [book, user, filename, body] = mocks.put.mock.calls[0];
    expect([book, user, filename]).toEqual(['book', 'owner', '0002__provider_failure.json']);
    const diagnostic = JSON.parse(body.toString());
    expect(diagnostic.stage).toBe('gemini-drama-tts');
    expect(diagnostic.failures).toEqual([{ speaker: 'Hero', sourceText: 'Hello.', chunkIndex: 0, attempts: 2, reason: 'GeminiTtsInputError' }]);
    expect(body.toString()).not.toContain(flag.extra);
  });
});
