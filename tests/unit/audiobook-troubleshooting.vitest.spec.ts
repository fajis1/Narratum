import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), put: vi.fn(), warn: vi.fn() }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({ listAudiobookObjects: storage.list, getAudiobookObjectBuffer: storage.get, putAudiobookObject: storage.put }));
vi.mock('@/lib/server/logger', () => ({ serverLogger: { warn: storage.warn } }));
import { collectTroubleshootingArtifacts, createTtsAttemptRecorder, isTroubleshootingArtifact, sanitizeTroubleshooting } from '@/lib/server/audiobooks/troubleshooting';

beforeEach(() => { vi.clearAllMocks(); storage.put.mockResolvedValue(undefined); });
describe('Audiobook troubleshooting artifacts', () => {
  it('removes nested credentials and audio but preserves usage and manuscript', () => {
    const result = sanitizeTroubleshooting({ sourceText: 'Hello', usage: { totalTokens: 12, inputTokenCount: 5 },
      apiKey: 'private', nested: { authorization: 'private', backupGeminiApiKey: 'private', cookie: 'private', password: 'private', data: 'base64', voice: 'Kore' },
      error: 'Bearer abcdef AIza12345678901234567890123456789' });
    expect(result).toEqual({ sourceText: 'Hello', usage: { totalTokens: 12, inputTokenCount: 5 }, nested: { voice: 'Kore' }, error: 'Bearer [REDACTED] [REDACTED]' });
  });
  it('only exports approved diagnostic and manuscript artifacts', () => {
    for (const name of ['drama-director-failure-chapter-0000.json', '0002__drama_segments.json', '0002__tts_attempts-run-id.json', '0002__provider_failure.json', '0002__rejected.txt', 'audiobook.meta.json']) expect(isTroubleshootingArtifact(name)).toBe(true);
    for (const name of ['complete.mp3', 'settings.json', '.env', '../0002__rejected.txt']) expect(isTroubleshootingArtifact(name)).toBe(false);
  });
  it('retains each attempt and uses distinct filenames for independent runs', async () => {
    const input = { bookId: 'book', userId: 'owner', chapterIndex: 1, jobId: 'job', namespace: 'test' };
    const record = { createdAt: 'now', durationMs: 2, request: { text: 'Hi', voice: 'Kore' }, segmentNumber: 1, speaker: 'Ali', httpStatus: 200, audioBytes: 200 };
    const recorder = createTtsAttemptRecorder(input);
    await recorder(record);
    await recorder({ ...record, httpStatus: 429, response: { error: { status: 'RESOURCE_EXHAUSTED', details: [{ quotaId: 'daily', retryDelay: '60s' }] } } });
    const args = storage.put.mock.calls[1];
    expect(args[0]).toBe('book'); expect(args[1]).toBe('owner'); expect(args[5]).toBe('test');
    expect(JSON.parse(args[3].toString())).toMatchObject({ jobId: 'job', totalAttempts: 2, attempts: [record, { httpStatus: 429 }] });
    await createTtsAttemptRecorder(input)(record);
    expect(storage.put.mock.calls[2][2]).not.toBe(args[2]);
  });
  it('does not turn a storage failure into another synthesis request', async () => {
    storage.put.mockRejectedValue(new Error('storage unavailable'));
    await expect(createTtsAttemptRecorder({ bookId: 'b', userId: 'u', chapterIndex: 0 })({ createdAt: 'now', durationMs: 1, request: {}, segmentNumber: 1, speaker: 'Ali' })).resolves.toBeUndefined();
    expect(storage.warn).toHaveBeenCalledOnce();
  });
  it('collects successful and failed chapters, preserving malformed Director JSON', async () => {
    storage.list.mockResolvedValue([{ fileName: '0002__drama_segments.json', size: 10, lastModified: 1 }, { fileName: 'drama-director-failure-chapter-0000.json', size: 10, lastModified: 2 }, { fileName: 'complete.mp3', size: 10 }]);
    storage.get.mockImplementation(async (_b, _u, name) => Buffer.from(name.includes('drama_segments') ? '{"segments":[],"apiKey":"hidden"}' : '{ malformed'));
    const result = await collectTroubleshootingArtifacts('b', 'u', 'test');
    expect(result.artifacts).toMatchObject([{ fileName: '0002__drama_segments.json', lastModified: 1, content: { segments: [] } }, { fileName: 'drama-director-failure-chapter-0000.json', lastModified: 2, content: '{ malformed' }]);
    expect(result.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(storage.get).toHaveBeenCalledTimes(2);
  });
  it('preserves invalid nested Director text inside a valid artifact and checksums original bytes', async () => {
    const nested = '{"text":"unescaped "quote""}';
    const raw = JSON.stringify({ attempts: [{ rawResponse: nested }], issues: ['invalid JSON'] });
    storage.list.mockResolvedValue([{ fileName: 'drama-director-failure-chapter-0000.json', size: raw.length, lastModified: 1 }]);
    storage.get.mockResolvedValue(Buffer.from(raw));
    const result = await collectTroubleshootingArtifacts('b', 'u', null);
    expect(result.artifacts[0].content).toEqual({ attempts: [{ rawResponse: nested }], issues: ['invalid JSON'] });
    expect(result.artifacts[0].sha256).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });
  it('reports oversized and unreadable artifacts without aborting the download', async () => {
    storage.list.mockResolvedValue([{ fileName: '0001__rejected.txt', size: 9 * 1024 * 1024 }, { fileName: '0002__rejected.txt', size: 10 }]);
    storage.get.mockRejectedValue(new Error('removed'));
    const result = await collectTroubleshootingArtifacts('b', 'u', null);
    expect(result.artifacts).toMatchObject([]); expect(result.unavailable).toHaveLength(2);
  });
});
