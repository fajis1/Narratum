import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rows: [] as unknown[][], collect: vi.fn(), summary: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.auth }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: () => {
  const result = { limit: async () => mocks.rows.shift() || [], orderBy: () => result }; return result;
} }) }) } }));
vi.mock('@/lib/server/testing/test-namespace', () => ({ getOpenReaderTestNamespace: () => 'test' }));
vi.mock('@/lib/server/audiobooks/troubleshooting', () => ({ collectTroubleshootingArtifacts: mocks.collect, sanitizeTroubleshooting: (value: unknown) => value }));
vi.mock('@/app/api/audiobook/failure-log/route', () => ({ GET: mocks.summary }));
import { GET } from '@/app/api/audiobook/troubleshooting/route';
const request = (query = 'bookId=book') => new NextRequest(`http://localhost/api/audiobook/troubleshooting?${query}`);
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ userId: 'owner' });
  mocks.rows = [[{ title: 'PDF' }], [], [{ id: 'new-job', status: 'queued', error: 'quota pause', createdAt: 2 }]];
  mocks.collect.mockResolvedValue({ artifacts: [{ fileName: '0002__drama_segments.json', content: { segments: [] } }], unavailable: [] });
  mocks.summary.mockResolvedValue(NextResponse.json({ failures: [], reviewFlags: [] }));
});
describe('Troubleshooting bundle download', () => {
  it('requires a valid book ID', async () => {
    expect((await GET(request(''))).status).toBe(400);
    expect((await GET(request('bookId=../private'))).status).toBe(400);
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it('requires authentication', async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await GET(request())).status).toBe(401); expect(mocks.collect).not.toHaveBeenCalled();
  });
  it('rejects books belonging to another user before reading any artifact', async () => {
    mocks.rows = [[], []];
    expect((await GET(request())).status).toBe(404);
    expect(mocks.collect).not.toHaveBeenCalled(); expect(mocks.summary).not.toHaveBeenCalled();
  });
  it('exports successful chapters and job metadata as a private attachment', async () => {
    const response = await GET(request('bookId=book&chapterIndex=0'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('attachment;');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.collect).toHaveBeenCalledWith('book', 'owner', 'test');
    expect(mocks.summary.mock.calls[0][0].nextUrl.searchParams.has('chapterIndex')).toBe(false);
    expect(await response.json()).toMatchObject({ bookId: 'book', bookTitle: 'PDF', jobs: [{ id: 'new-job', status: 'queued' }], artifacts: [{ fileName: '0002__drama_segments.json' }] });
  });
  it('still returns saved artifacts when the summary is unavailable', async () => {
    mocks.summary.mockResolvedValue(NextResponse.json({}, { status: 500 }));
    expect(await (await GET(request())).json()).toMatchObject({ summary: { unavailable: true }, artifacts: [{ fileName: '0002__drama_segments.json' }] });
  });
});
