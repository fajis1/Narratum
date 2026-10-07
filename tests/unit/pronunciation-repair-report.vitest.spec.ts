import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rows: [] as unknown[], get: vi.fn(), head: vi.fn() }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.rows }) }) }) } }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({ getAudiobookObjectBuffer: (...args: unknown[]) => mocks.get(...args), headAudiobookObject: (...args: unknown[]) => mocks.head(...args) }));
import { pronunciationRepairReport } from '@/lib/server/audiobooks/pronunciation-repair-report';
const id = 'ce5c61c4-5aa6-4d6f-9f3b-469543d2e321';
beforeEach(() => { vi.clearAllMocks(); mocks.rows = []; mocks.head.mockResolvedValue({ contentLength: 1000 }); });
test('exports all legacy failures without inventing discarded diagnostics', async () => {
  mocks.rows = [{ id, status: 'error', progress: 100, settingsJson: { jobType: 'pronunciation-repair', chapters: Array(48).fill({}), results: [
    ...Array.from({ length: 42 }, (_, index) => ({ fileName: `${index + 1}__text.txt`, requestId: `req-${index}`, error: index < 35 ? 'Validation failed' : 'Missing patches' })),
    ...Array.from({ length: 6 }, (_, index) => ({ fileName: `${index + 50}__text.txt`, runId: `run-${index}` })),
  ] } }];
  const report = await pronunciationRepairReport('book', 'owner', id);
  expect(report?.summary).toMatchObject({ selectedChapters: 48, proposals: 6, failures: 42, failureReasons: { 'Validation failed': 35, 'Missing patches': 7 } });
  expect(report?.chapters).toHaveLength(48);
  expect(report?.chapters[0].diagnosticsUnavailable).toContain('Not retained');
  expect(mocks.get).not.toHaveBeenCalled();
});
test('loads captured detail using the owned book scope and degrades gracefully if missing', async () => {
  const file = `pronunciation_repair_${id}.json`;
  mocks.rows = [{ id, settingsJson: { jobType: 'pronunciation-repair', chapters: [{}], results: [{ fileName: '0001__text.txt', error: 'Validation failed', diagnosticsFile: file }] } }];
  mocks.get.mockResolvedValue(Buffer.from(JSON.stringify({ version: 1, promptVersion: 1, stage: 'chapter-validation', validatorReason: 'Repair changed surrounding chapter text.' })));
  const report = await pronunciationRepairReport('book', 'owner', id);
  expect(mocks.get).toHaveBeenCalledWith('book', 'owner', file, null);
  expect(report?.chapters[0].diagnostics?.validatorReason).toBe('Repair changed surrounding chapter text.');
  mocks.get.mockRejectedValue(new Error('Missing'));
  expect((await pronunciationRepairReport('book', 'owner', id))?.chapters[0].diagnosticsUnavailable).toContain('could not be read');
});
test('refuses missing jobs and never reads a forged diagnostic path', async () => {
  expect(await pronunciationRepairReport('book', 'owner', id)).toBeNull();
  mocks.rows = [{ id, settingsJson: { jobType: 'pronunciation-repair', results: [{ fileName: '0001__text.txt', error: 'failed', diagnosticsFile: '../private' }] } }];
  await pronunciationRepairReport('book', 'owner', id);
  expect(mocks.get).not.toHaveBeenCalled();
});
test('separates API blocking from ambiguity and includes earlier attempt diagnostics', async () => {
  const file = `pronunciation_repair_${id}.json`;
  mocks.rows = [{ id, settingsJson: { jobType: 'pronunciation-repair', chapters: [{}, {}, {}], nextAttemptAt: 123,
    results: [{ fileName: '0001__text.txt', runId: 'partial', unresolvedCount: 2, apiBlocked: true, previousAttempts: [{ requestId: 'earlier', diagnosticsFile: file }] },
      { fileName: '0002__text.txt', error: 'Rejected candidates' }] } }];
  mocks.get.mockResolvedValue(Buffer.from(JSON.stringify({ version: 1, promptVersion: 4, stage: 'gemini-response', apiBlocked: true })));
  const report = await pronunciationRepairReport('book', 'owner', id);
  expect(report?.summary).toMatchObject({ completeProposals: 0, partialProposals: 1, apiBlockedChapters: 1, unprocessedChapters: 1 });
  expect(report?.chapters[0]).toMatchObject({ needsReview: true, recoveryStatus: 'api_blocked', previousAttempts: [{ requestId: 'earlier', diagnostics: { apiBlocked: true } }] });
  expect(report?.chapters[1].needsReview).toBe(true);
});
test('does not count retained failed proposals or advertise a retry for a terminal job', async () => {
  mocks.rows = [{ id, status: 'error', settingsJson: { jobType: 'pronunciation-repair', chapters: Array(26).fill({}), nextAttemptAt: 123,
    results: [{ fileName: '0067__text.txt', runId: 'old', error: 'Preparation failed' },
      { fileName: '0079__text.txt', runId: 'new', unresolvedCount: 0, proposalAction: 'created' },
      { fileName: '0081__text.txt', runId: 'updated', unresolvedCount: 0, proposalAction: 'updated' },
      { fileName: '0092__text.txt', error: 'HTTP 429', apiBlocked: true }] } }];
  const report = await pronunciationRepairReport('book', 'owner', id);
  expect(report?.summary).toMatchObject({ proposals: 2, completeProposals: 2, partialProposals: 0, retainedProposalReferences: 1,
    createdProposals: 1, updatedProposals: 1, failures: 2, unprocessedChapters: 22 });
  expect(report?.nextAttemptAt).toBeUndefined();
  expect(report?.chapters[0]).toMatchObject({ outcome: 'failed', proposalAction: 'retained', proposalRunId: 'old' });
});

test('preserves optional contextual classification while reading legacy diagnostic artifacts', async () => {
  const file = `pronunciation_repair_${id}.json`;
  mocks.rows = [{ id, status: 'completed', progress: 100, settingsJson: { jobType: 'pronunciation-repair', chapters: [{}], results: [{ fileName: '0001__text.txt', runId: 'saved', unresolvedCount: 0, diagnosticsFile: file }] } }];
  mocks.get.mockResolvedValue(Buffer.from(JSON.stringify({ version: 1, promptVersion: 9, stage: 'complete', findings: [{ id: '0', start: 4, end: 5, original: 'Θ', context: 'The Θ edition.', scanReason: 'Greek or Hebrew is outside a pronunciation tag.', issueKind: 'contextual', source: 'contextual-letter-name', validationScope: 'contextual-only', tokenClassification: { kind: 'contextual_letter_reference', script: 'Greek', reason: 'Adjacent scholarly label.' }, reasons: [], outcome: 'resolved' }] })));
  const report = await pronunciationRepairReport('book', 'owner', id);
  expect(report?.chapters[0]).toMatchObject({ unresolvedCount: 0, needsReview: false, diagnostics: { findings: [{ validationScope: 'contextual-only', tokenClassification: { kind: 'contextual_letter_reference' } }] } });
  expect(report?.retryScheduleActive).toBe(false);
});
