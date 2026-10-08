import { beforeEach, expect, test, vi } from 'vitest';
import { batchRefineTextHash } from '../../src/lib/server/audiobooks/batch-refine-assessment';
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], objects: new Map<string, string>(), put: vi.fn(), update: vi.fn() }));
vi.mock('@/db', () => ({ db: {
  select: () => {
    const rows = mocks.rows.shift() || [];
    const query = { from: () => query, innerJoin: () => query, where: () => query, limit: async () => rows,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
    return query;
  },
  update: () => ({ set: (value: unknown) => { mocks.update(value); return { where: async () => [] }; } }),
} }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  getAudiobookObjectBuffer: async (_book: string, _user: string, file: string) => {
    if (!mocks.objects.has(file)) throw new Error('Missing fixture');
    return Buffer.from(mocks.objects.get(file)!);
  },
  listAudiobookObjects: async () => [...mocks.objects.keys()].map(fileName => ({ fileName })),
  putAudiobookObject: (...args: unknown[]) => mocks.put(...args),
}));
import { approveBatchRefineChange } from '../../src/lib/server/audiobooks/batch-refine-review-store';
const previous = 'The [Aetherian](/bad split/) arrived.';
const proposed = 'The [Aetherian](/eɪθɪriən/) arrived.';
function owned(fileName = '0107__text.txt') {
  return { run: { id: 'run', rule: 'pronunciation-repair:v1', profileCategory: 'standard' }, change: {
    id: 'change', userId: 'user', documentId: 'book', decision: 'pending', audioStatus: 'not_requested',
    fileName, textFileName: fileName, previousText: previous, proposedText: proposed,
    sourceTextHash: batchRefineTextHash(previous), proposedTextHash: batchRefineTextHash(proposed),
    flagsJson: [], reviewPriority: 'high', reviewNote: 'repair',
  } };
}
beforeEach(() => { vi.clearAllMocks(); mocks.rows = []; mocks.objects.clear(); });
test('approving a failed output writes the canonical chapter, not the rejected snapshot', async () => {
  mocks.rows = [[owned('0107__rejected.txt')], []];
  mocks.objects.set('0107__rejected.txt', previous);
  mocks.objects.set('0107__pronunciation_failure.json', JSON.stringify({ rejectedHash: batchRefineTextHash(previous), canonicalHash: null }));
  expect(await approveBatchRefineChange({ changeId: 'change', userId: 'user' })).toEqual({ changeId: 'change', queued: true });
  expect(mocks.put).toHaveBeenCalledWith('book', 'user', '0107__text.txt', Buffer.from(proposed), expect.any(String), null);
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approved', audioStatus: 'queued' }));
});
test('approval records the selected replacement recording voice', async () => {
  mocks.rows = [[owned()], []];
  mocks.objects.set('0107__text.txt', previous);
  await approveBatchRefineChange({ changeId: 'change', userId: 'user', recordingVoice: 'af_heart' });
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ reviewNote: 'repair [Recording voice=af_heart]' }));
});
test('rejects edits outside the flagged region before writing text or queueing audio', async () => {
  mocks.rows = [[owned()], []];
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user', editedText: proposed.replace('arrived', 'departed') })).rejects.toThrow();
  expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
});
test('allows an explicitly confirmed full manual edit while retaining pronunciation safety', async () => {
  mocks.rows = [[owned()], []];
  mocks.objects.set('0107__text.txt', previous);
  const editedText = 'A preface. The [Aetherian](/eɪθɪriən/) arrived.';
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user', editedText, overrideFullManualEdit: true })).resolves.toEqual({ changeId: 'change', queued: true });
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
    proposedText: editedText,
    reviewNote: expect.stringContaining('[Reviewer override: entire manual edit;'),
  }));
});
test('protects a canonical chapter changed after failed generation', async () => {
  mocks.rows = [[owned('0107__rejected.txt')], []];
  mocks.objects.set('0107__rejected.txt', previous);
  mocks.objects.set('0107__text.txt', 'A newer manual edit.');
  mocks.objects.set('0107__pronunciation_failure.json', JSON.stringify({ rejectedHash: batchRefineTextHash(previous), canonicalHash: null }));
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user' })).rejects.toThrow('saved chapter changed');
  expect(mocks.put).not.toHaveBeenCalled();
});
test('blocks approval while background generation is active', async () => {
  mocks.rows = [[owned()], [{ status: 'running' }]];
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user' })).rejects.toThrow('Pause');
  expect(mocks.put).not.toHaveBeenCalled();
});


test('Override approval persists an audited marker and bypasses Scholar completeness only for repair runs', async () => {
  const oldText = 'The Θ edition and 7:28 Θ. [περι](/pɛr/)';
  const newText = 'The [Θ](/θeɪtə/) edition and 7:28 Θ. [περι](/pɛr/)';
  const row = owned();
  row.run.profileCategory = 'scholar';
  row.change.previousText = oldText; row.change.proposedText = newText;
  row.change.sourceTextHash = batchRefineTextHash(oldText); row.change.proposedTextHash = batchRefineTextHash(newText);
  mocks.rows = [[row], []]; mocks.objects.set('0107__text.txt', oldText);
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user', overridePronunciationReview: true })).resolves.toMatchObject({ queued: true });
  expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ decision: 'approved', reviewNote: expect.stringContaining('[Reviewer override: pronunciation warnings; source integrity retained.]') }));
  mocks.update.mockClear(); mocks.put.mockClear(); row.run.rule = 'ordinary refinement'; mocks.rows = [[row]];
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user', overridePronunciationReview: true })).rejects.toThrow('only');
  expect(mocks.put).not.toHaveBeenCalled();
});

test('Override cannot approve changed source or a stale chapter', async () => {
  mocks.rows = [[owned()], []]; mocks.objects.set('0107__text.txt', previous);
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user', overridePronunciationReview: true, editedText: proposed.replace('arrived', 'left') })).rejects.toThrow();
  expect(mocks.put).not.toHaveBeenCalled();
  mocks.rows = [[owned()], []]; mocks.objects.set('0107__text.txt', 'A newer saved version.');
  await expect(approveBatchRefineChange({ changeId: 'change', userId: 'user', overridePronunciationReview: true })).rejects.toThrow('changed');
  expect(mocks.put).not.toHaveBeenCalled();
});
