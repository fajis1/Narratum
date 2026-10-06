import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '@/types/document-settings';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), rows: [] as unknown[][], get: vi.fn(), put: vi.fn(), generate: vi.fn(), profiles: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.auth }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.rows.shift() || [] }) }) }) } }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  getAudiobookObjectBuffer: mocks.get, putAudiobookObject: mocks.put,
  isMissingBlobError: (error: unknown) => error instanceof Error && error.message === 'missing',
}));
vi.mock('@/lib/server/audiobooks/cloud-drama', () => ({ generateCloudDramaAudiobook: mocks.generate }));
vi.mock('@/lib/server/smart-audio-profiles', () => ({
  readSmartAudioProfilesDocument: mocks.profiles,
  findSmartAudioProfileById: (profiles: Array<{ id: string }>, id: string) => profiles.find((profile) => profile.id === id),
}));

import { GET, POST } from '@/app/api/audiobook/drama-segments/route';
import { saveDramaSpeakerReview } from '@/lib/server/audiobooks/drama-speaker-review';
import { getMatchingDramaSpeakerReview } from '@/lib/shared/drama-speaker-review';

const segment: DramaDirectorSegment = {
  speaker: 'Bethany', utteranceType: 'spoken-dialogue', text: 'Understood.', sceneContext: 'Ali waits for a reply.', omit_from_audio: false,
  performance: { primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'informing', delivery: ['natural'], pace: 'normal', energy: 'low', intensity: 'low', tags: [] },
};
const map: SmartAudioCharacterMap = {
  schemaVersion: 1, status: 'complete', scannedAt: 1, entries: {
    Bethany: { name: 'Bethany', voiceId: 'Kore', description: '', sampleText: '' },
    Ali: { name: 'Ali', voiceId: 'Kore', description: '', sampleText: '' },
  },
};
const profile = { id: 'drama', workerMode: 'drama-gemini-tts', geminiApiKey: 'test-key' };
const request = () => new NextRequest('http://localhost/api/audiobook/drama-segments', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: 'book', chapterIndex: 0, profileId: 'drama' }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: 'owner' });
  mocks.rows = [[{ id: 'book' }], [{ dataJson: JSON.stringify({ smartAudioCharacters: map }) }]];
  mocks.profiles.mockResolvedValue([profile]);
  mocks.get.mockResolvedValue(Buffer.from(segment.text));
  mocks.put.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({ segments: [segment], audioBuffer: Buffer.alloc(0), reviewFlags: [] });
});

describe('Gemini Drama speaker review', () => {
  it('persists ordered turns with distinct character names even when voices are shared', async () => {
    const turns = [segment, { ...segment, speaker: 'Ali', text: 'As my lady requests.' }];
    const sourceText = turns.map((turn) => turn.text).join('');
    const review = await saveDramaSpeakerReview({ bookId: 'book', userId: 'owner', chapterIndex: 0,
      profileId: 'drama', sourceText, characterMap: map, segments: turns, complete: true });
    expect(mocks.put.mock.calls[0][2]).toBe('0001__drama_segments.json');
    expect(review.segments.map((turn) => [turn.speaker, turn.voiceId])).toEqual([['Bethany', 'Kore'], ['Ali', 'Kore']]);
    expect(review.segments.map((turn) => turn.text).join('')).toBe(sourceText);
    expect(getMatchingDramaSpeakerReview(review, sourceText)).toBe(review);
    expect(getMatchingDramaSpeakerReview(review, sourceText + 'Changed.')).toBeNull();
    expect(JSON.stringify(review)).not.toContain(profile.geminiApiKey);
  });

  it('prepares old chapter assignments from saved text without recording audio', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ directionOnly: true, cleanedText: segment.text }));
    const { review } = await response.json();
    expect(review.preparedOnly).toBe(true);
    expect(review.segments[0].speaker).toBe('Bethany');
    expect(JSON.stringify(review)).not.toContain(profile.geminiApiKey);
  });

  it('falls back to rejected text for failed chapters', async () => {
    mocks.get.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(Buffer.from(segment.text));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.get.mock.calls.map((call) => call[2])).toEqual(['0001__text.txt', '0001__rejected.txt']);
  });

  it('does not contact Gemini or storage for a book owned by someone else', async () => {
    mocks.rows = [[]];
    expect((await POST(request())).status).toBe(404);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('returns an explicit absent-review state for historical chapters', async () => {
    mocks.get.mockRejectedValue(new Error('missing'));
    const response = await GET(new NextRequest('http://localhost/api/audiobook/drama-segments?bookId=book&chapterIndex=0'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ review: null });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('loads persisted assignments without calling Gemini', async () => {
    mocks.get.mockResolvedValue(Buffer.from(JSON.stringify({ segments: [segment] })));
    const response = await GET(new NextRequest('http://localhost/api/audiobook/drama-segments?bookId=book&chapterIndex=0'));
    expect((await response.json()).review.segments[0].speaker).toBe('Bethany');
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});
