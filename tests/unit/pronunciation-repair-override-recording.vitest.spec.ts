import { beforeEach, expect, test, vi } from 'vitest';
import { batchRefineTextHash } from '@/lib/server/audiobooks/batch-refine-assessment';
import { PRONUNCIATION_REPAIR_RULE } from '@/lib/shared/pronunciation-issues';
import { PRONUNCIATION_REVIEW_OVERRIDE_NOTE } from '@/lib/server/audiobooks/pronunciation-repair-validation';
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], claimed: [] as unknown[], update: vi.fn(), tts: vi.fn(), text: '', jobs: [] as unknown[] }));
vi.mock('@/db', () => ({ db: {
  select: () => {
    const rows = mocks.rows.shift() || [];
    const query = { from: () => query, where: () => query, orderBy: () => query, limit: async () => rows, then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
    return query;
  },
  update: () => ({ set: (value: unknown) => { mocks.update(value); return { where: () => ({ returning: async () => mocks.claimed }) }; } }),
} }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  getAudiobookObjectBuffer: async (_book: string, _user: string, file: string) => Buffer.from(file === 'audiobook.meta.json' ? '{}' : mocks.text),
  listAudiobookObjects: async () => [],
}));
vi.mock('@/lib/server/logger', () => ({ serverLogger: { error: vi.fn() }, errorToLog: (error: unknown) => error }));
vi.mock('@/lib/server/runtime-config', () => ({ getResolvedRuntimeConfig: async () => ({ defaultTtsProvider: 'kokoro', restrictUserApiKeys: false }) }));
vi.mock('@/lib/server/audiobooks/settings', () => ({ coerceAudiobookGenerationSettings: () => ({ settings: { voice: 'af_heart', format: 'mp3', nativeSpeed: 1 } }) }));
vi.mock('@/lib/server/admin/resolve-credentials', () => ({ resolveTtsCredentials: async () => ({ provider: 'kokoro', apiKey: 'fixture', baseUrl: 'http://fixture' }) }));
vi.mock('@/lib/server/admin/tts-instructions', () => ({ resolveEffectiveTtsInstructions: () => '' }));
vi.mock('@/lib/shared/tts-provider-policy', () => ({ resolveTtsModelForProvider: () => 'kokoro' }));
vi.mock('@/lib/server/audiobooks/segmented-tts', () => ({ generateSegmentedAudiobookTtsBuffer: (...args: unknown[]) => mocks.tts(...args) }));
import { processBatchRefineRecordingQueue } from '@/lib/server/audiobooks/batch-refine-recordings';
const previous = 'The Θ edition and 7:28 Θ. [περι](/pɛr/)';
const proposed = 'The [Θ](/θeɪtə/) edition and 7:28 Θ. [περι](/pɛr/)';
beforeEach(() => { vi.clearAllMocks(); mocks.tts.mockRejectedValue(new Error('Fixture reached TTS; no audio generated')); });
async function run(override: boolean, text = proposed, jobs: unknown[] = []) {
  mocks.text = text;
  const change = { id: 'change', documentId: 'book', userId: 'owner', runId: 'run', textFileName: '0001__text.txt', previousText: previous, proposedTextHash: batchRefineTextHash(text), reviewNote: override ? PRONUNCIATION_REVIEW_OVERRIDE_NOTE : '' };
  mocks.claimed = [change];
  mocks.rows = [[change], [{ rule: PRONUNCIATION_REPAIR_RULE, profileCategory: 'scholar' }], jobs, [], []];
  return processBatchRefineRecordingQueue({ signal: new AbortController().signal, deadlineAt: Date.now() + 10000 });
}
test('recording honors the persisted Override and reaches TTS with the approved text unchanged', async () => {
  await run(true);
  expect(mocks.tts).toHaveBeenCalledOnce();
  expect(mocks.tts).toHaveBeenCalledWith(expect.objectContaining({ text: proposed }), expect.anything(), expect.anything());
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ audioError: 'Fixture reached TTS; no audio generated' }));
});
test('ordinary recording remains strict without persisted Override', async () => {
  await run(false);
  expect(mocks.tts).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ audioError: expect.stringContaining('remain') }));
});
test('Override cannot bypass source integrity or a conflicting generation job', async () => {
  await run(true, proposed.replace('edition', 'translation'));
  expect(mocks.tts).not.toHaveBeenCalled();
  await run(true, proposed, [{ status: 'running' }]);
  expect(mocks.tts).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ audioError: expect.stringContaining('Pause generation') }));
});
