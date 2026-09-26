import { beforeEach, describe, expect, test, vi } from 'vitest';
import { batchRefineTextHash } from '../../src/lib/server/audiobooks/batch-refine-assessment';

const mocks = vi.hoisted(() => ({
  objects: new Map<string, string>(), selectResults: [] as unknown[][],
  profile: { id: 'profile', name: 'Standard', workerMode: 'standard', pronunciations: {} as Record<string, string>, geminiApiKey: 'fixture' },
  createRun: vi.fn(), insert: vi.fn(), finish: vi.fn(), put: vi.fn(), gemini: vi.fn(), fetch: vi.fn(), update: vi.fn(),
}));
vi.mock('@/db', () => ({ db: { select: () => {
  const rows = mocks.selectResults.shift() || [];
  const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: () => chain, limit: async () => rows,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
  return chain;
}, update: () => ({ set: (values: unknown) => ({ where: () => ({ returning: () => mocks.update(values) }) }) }) } }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  headAudiobookObject: async (_book: string, _user: string, file: string) => {
    if (!mocks.objects.has(file)) throw Object.assign(new Error('Not found'), { name: 'NoSuchKey' });
    return { contentLength: Buffer.byteLength(mocks.objects.get(file)!) };
  },
  isMissingBlobError: (error: Error) => error.name === 'NoSuchKey',
  listAudiobookObjects: async () => [...mocks.objects].map(([fileName, text]) => ({ fileName, size: Buffer.byteLength(text), lastModified: 1 })),
  getAudiobookObjectBuffer: async (_book: string, _user: string, file: string) => {
    if (!mocks.objects.has(file)) throw new Error('Not found');
    return Buffer.from(mocks.objects.get(file)!);
  },
  putAudiobookObject: (...args: unknown[]) => mocks.put(...args),
}));
vi.mock('@/lib/server/audiobooks/batch-refine-review-store', () => ({
  createBatchRefineRun: (...args: unknown[]) => mocks.createRun(...args),
  insertBatchRefineProposal: (...args: unknown[]) => mocks.insert(...args),
  finishBatchRefineRun: (...args: unknown[]) => mocks.finish(...args),
  updateBatchRefineRunProgress: vi.fn(), markBatchRefineRunStarted: vi.fn(),
}));
vi.mock('@/lib/server/smart-audio-profiles', () => ({ readSmartAudioProfilesDocument: async () => ({ selectedProfileId: 'profile', profiles: [mocks.profile] }), findSmartAudioProfileById: () => mocks.profile }));
vi.mock('@/lib/server/smart-audio/book-lexicon', () => ({ readBookLexicon: async () => null }));
vi.mock('@/lib/server/smart-audio/gemini-failover', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/server/smart-audio/gemini-failover')>(), fetchGeminiWithRateLimitFallback: (...args: unknown[]) => mocks.gemini(...args) }));

import { pronunciationCatalog, proposePronunciationRepair, readPronunciationChapter, resumeRepairedPronunciationJob } from '../../src/lib/server/audiobooks/pronunciation-repairs';
import { savePronunciationFailure } from '../../src/lib/server/audiobooks/pronunciation-failures';
import { listPronunciationRepairStatus } from '../../src/lib/server/audiobooks/pronunciation-repair-status';
import { pronunciationRepairStatusLabel } from '../../src/lib/shared/pronunciation-repair-status';

const base = { bookId: 'book', userId: 'user', fileName: '0107__text.txt', signal: new AbortController().signal };
test('current repair status deduplicates older chapter runs and excludes partial/approved/rejected proposals from ready', async () => {
  const row = { changeId: 'new', runId: 'run', fileName: '0001__text.txt', chapterIndex: 0, title: 'One', decision: 'approved', audioStatus: 'completed', proposedText: 'Good text.' };
  mocks.selectResults.push([
    row, { ...row, changeId: 'older', decision: 'pending' },
    { ...row, chapterIndex: 1, decision: 'pending', proposedText: 'θεῷ' },
    { ...row, chapterIndex: 2, decision: 'pending' },
    { ...row, chapterIndex: 3, decision: 'rejected' },
  ]);
  const result = await listPronunciationRepairStatus('book', 'user');
  expect(result).toHaveLength(4);
  expect(result.map(item => item.ready)).toEqual([false, false, true, false]);
  expect(result.map(pronunciationRepairStatusLabel)).toEqual(['Complete', 'Needs review', 'Awaiting approval', 'Kept previous text']);
  expect(result[0]).not.toHaveProperty('proposedText');
  expect(pronunciationRepairStatusLabel({ ...result[0], audioStatus: 'queued' })).toBe('Recording queued');
  expect(pronunciationRepairStatusLabel({ ...result[0], audioStatus: 'running' })).toBe('Recording in progress');
  expect(pronunciationRepairStatusLabel({ ...result[0], audioStatus: 'error' })).toContain('Recording failed');
});
function seed(text: string) {
  mocks.objects.set(base.fileName, text);
  mocks.objects.set('0107__original.txt', 'Original source context.');
  return { ...base, hash: batchRefineTextHash(text) };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.objects.clear(); mocks.selectResults = []; mocks.profile.pronunciations = {};
  mocks.update.mockResolvedValue([{ id: 'change' }]);
  vi.stubGlobal('fetch', async (...args: unknown[]) => (await mocks.fetch(...args)).clone());
  mocks.gemini.mockImplementation(async ({ request }) => ({ response: await request('fixture', 'fixture-model') }));
});

describe('pronunciation repair service', () => {
  test('retries current proposal offsets, preserves earlier repairs, and updates only a pending matching version', async () => {
    const input = seed('Read τὸ θεῷ.');
    const proposedText = 'Read [τὸ](/toʊ/) θεῷ.';
    const proposalHash = batchRefineTextHash(proposedText);
    mocks.selectResults = [[], [{ id: 'change', runId: 'existing', decision: 'pending', proposedText, proposedTextHash: proposalHash }]];
    mocks.fetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: '[θεῷ](/θeɪoʊ/)' }] }) }] } }] }));
    const result = await proposePronunciationRepair({ ...input, retryRunId: 'existing', proposalHash });
    expect(result).toMatchObject({ runId: 'existing', unresolvedCount: 0 });
    const payload = JSON.parse(JSON.parse(mocks.fetch.mock.calls[0][1].body).contents[0].parts[0].text);
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({ text: 'θεῷ', start: proposedText.indexOf('θεῷ') });
    expect(mocks.update.mock.calls[0][0].proposedText).toBe('Read [τὸ](/toʊ/) [θεῷ](/θeɪoʊ/).');
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('rejects stale proposal retries before invoking Gemini', async () => {
    const input = seed('Read τὸ θεῷ.');
    mocks.selectResults = [[], [{ runId: 'existing', decision: 'pending', proposedTextHash: 'changed' }]];
    await expect(proposePronunciationRepair({ ...input, retryRunId: 'existing', proposalHash: 'stale' })).rejects.toThrow('Proposal changed');
    expect(mocks.gemini).not.toHaveBeenCalled();
  });
  test('captures exact existing-proposal validation failures before any Gemini request', async () => {
    const input = seed('Read τὸ θεῷ.');
    const proposedText = 'Changed [τὸ](/toʊ/) θεῷ.';
    const proposalHash = batchRefineTextHash(proposedText);
    const onDiagnostics = vi.fn();
    mocks.selectResults = [[], [{ id: 'change', runId: 'existing', decision: 'pending', proposedText, proposedTextHash: proposalHash }]];
    await expect(proposePronunciationRepair({ ...input, retryRunId: 'existing', proposalHash, onDiagnostics })).rejects.toThrow('saved proposal failed validation');
    expect(onDiagnostics.mock.calls[0][0]).toMatchObject({ stage: 'existing-proposal-validation', aiRequested: false,
      validatorReason: 'Repair changed text outside a flagged passage.', errorType: 'PronunciationRepairError' });
    expect(mocks.gemini).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  test('does not overwrite a proposal changed while its retry was running', async () => {
    const input = seed('Read τὸ θεῷ.');
    const proposedText = 'Read [τὸ](/toʊ/) θεῷ.';
    const proposalHash = batchRefineTextHash(proposedText);
    mocks.selectResults = [[], [{ id: 'change', runId: 'existing', decision: 'pending', proposedText, proposedTextHash: proposalHash }]];
    mocks.update.mockResolvedValue([]);
    mocks.profile.pronunciations = { 'θεῷ': '/θeɪoʊ/' };
    await expect(proposePronunciationRepair({ ...input, retryRunId: 'existing', proposalHash })).rejects.toThrow('Proposal changed during repair');
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('retains rejected candidates when a correction omits their finding', async () => {
    const onDiagnostics = vi.fn();
    const response = (patches: unknown[]) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches }) }] } }] });
    mocks.fetch.mockResolvedValueOnce(response([{ id: '0', replacement: '[σ](/s/)', alternatives: ['[σ](/sɪɡmɑ/)'] }])).mockResolvedValueOnce(response([]));
    await expect(proposePronunciationRepair({ ...seed('Read σ.'), onDiagnostics })).rejects.toThrow();
    const diagnostics = onDiagnostics.mock.calls[0][0];
    expect(diagnostics.findings[0].outcome).toBe('candidate_rejected');
    expect(diagnostics.findings[0].reasons.join(' ')).toContain('stray Greek');
    expect(diagnostics.validatorReason).not.toBe('No replacement returned for this finding.');
    expect(diagnostics.rounds).toHaveLength(2);
    expect(diagnostics.candidateChecks.every((check: { round: number }) => check.round === 1)).toBe(true);
  });

  test('classifies 429 as API-blocked and retains retry guidance without secret error messages', async () => {
    const onDiagnostics = vi.fn();
    mocks.fetch.mockResolvedValue(Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'private-message' } }, { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(proposePronunciationRepair({ ...seed('Read θεῷ.'), onDiagnostics })).rejects.toThrow('Gemini API blocked; no usable candidates');
    const diagnostics = onDiagnostics.mock.calls[0][0];
    expect(diagnostics).toMatchObject({ apiBlocked: true, findings: [{ outcome: 'api_blocked' }], attempts: [{ round: 1, errorDetails: { retryAfterMs: 120000, apiStatus: 'RESOURCE_EXHAUSTED' } }] });
    expect(diagnostics.nextAttemptAt).toBeGreaterThan(Date.now() + 299000);
    expect(JSON.stringify(diagnostics)).not.toContain('private-message');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  test('saves valid dictionary repairs when Gemini leaves ambiguous findings unresolved', async () => {
    mocks.profile.pronunciations = { 'τὸ': '/toʊ/' };
    mocks.fetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: '{"patches":[]}' }] } }] }));
    const onDiagnostics = vi.fn();
    const result = await proposePronunciationRepair({ ...seed('Read τὸ θ.'), onDiagnostics });
    expect(result.unresolvedCount).toBe(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ proposedText: 'Read [τὸ](/toʊ/) θ.', metrics: { reviewNote: expect.stringContaining('NEEDS REVIEW') } });
    expect(onDiagnostics.mock.calls[0][0].findings).toEqual(expect.arrayContaining([expect.objectContaining({ original: 'τὸ', source: 'profile-dictionary' })]));
  });

  test('correction retries send only rejected findings and their reasons', async () => {
    const response = (patches: unknown[]) => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches }) }] } }] });
    mocks.fetch.mockResolvedValueOnce(response([{ id: '0', replacement: '[τὸ](/toʊ/)' }, { id: '1', replacement: '[θεῷ](/θ eɪ oʊ/)' }]))
      .mockResolvedValueOnce(response([{ id: '1', replacement: '[θεῷ](/θeɪoʊ/)' }]));
    await proposePronunciationRepair(seed('Read τὸ θεῷ.'));
    const retry = JSON.parse(JSON.parse(mocks.fetch.mock.calls[1][1].body).contents[0].parts[0].text);
    expect(retry.findings.map((finding: { id: string }) => finding.id)).toEqual(['1']);
    expect(retry.validationFeedback[0].reasons.length).toBeGreaterThan(0);
    expect(mocks.insert.mock.calls[0][0].proposedText).toBe('Read [τὸ](/toʊ/) [θεῷ](/θeɪoʊ/).');
  });

  test('retries invalid JSON once and preserves valid dictionary patches on exhausted API failure', async () => {
    mocks.profile.pronunciations = { 'τὸ': '/toʊ/' };
    mocks.fetch.mockResolvedValue(new Response('<html>private upstream body</html>'));
    const result = await proposePronunciationRepair(seed('Read τὸ θεῷ.'));
    expect(result.unresolvedCount).toBe(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.insert.mock.calls[0][0].proposedText).toBe('Read [τὸ](/toʊ/) θεῷ.');
  });

  test('uses a dictionary repair without Gemini and stores a proposal, never canonical text', async () => {
    mocks.profile.pronunciations = { Aetherian: '/eɪθɪriən/' };
    const result = await proposePronunciationRepair(seed('The [Aetherian](/bad split/) arrived.'));
    expect(result.dictionaryRepairs).toBe(1);
    expect(mocks.gemini).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ previousText: 'The [Aetherian](/bad split/) arrived.', proposedText: 'The [Aetherian](/eɪθɪriən/) arrived.' }));
    expect(mocks.put.mock.calls.every(call => String(call[2]).endsWith('.diff'))).toBe(true);
  });

  test('repairs independent malformed closing delimiters locally without Gemini', async () => {
    const text = '[ἀνθρώποις](/ɑnθroʊpɔɪs/] [ἰσόθεον](/isoʊθɛɒn/) and [ποικίλων](/pɔɪkɪloʊn/]';
    const result = await proposePronunciationRepair(seed(text));
    expect(result).toMatchObject({ dictionaryRepairs: 2, aiRepairs: 0, unresolvedCount: 0 });
    expect(mocks.gemini).not.toHaveBeenCalled();
    expect(mocks.insert.mock.calls[0][0].proposedText).toBe(
      '[ἀνθρώποις](/ɑnθroʊpɔɪs/) [ἰσόθεον](/isoʊθɛɒn/) and [ποικίλων](/pɔɪkɪloʊn/)',
    );
  });

  test('sends only the affected chapter and original context; applies returned patches', async () => {
    const input = seed('God θεοῦ.'); mocks.objects.set('0108__text.txt', 'UNRELATED CHAPTER');
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: '[θεοῦ](/θɛu/)' }] }) }] } }] })));
    await proposePronunciationRepair(input);
    const payload = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    const context = JSON.parse(payload.contents[0].parts[0].text);
    expect(context.originalSource).toBe('Original source context.');
    expect(context.chapterContext).toBe('God θεοῦ.');
    expect(JSON.stringify(payload)).not.toContain('UNRELATED CHAPTER');
    expect(mocks.insert.mock.calls[0][0].proposedText).toBe('God [θεοῦ](/θɛu/).');
  });

  test('rejects stale scans, active jobs, and healthy chapters without invoking Gemini', async () => {
    const input = seed('God θεοῦ.');
    await expect(proposePronunciationRepair({ ...input, hash: 'stale' })).rejects.toThrow('changed');
    mocks.selectResults = [[{ id: 'active' }]];
    await expect(proposePronunciationRepair(input)).rejects.toThrow('Pause');
    await expect(proposePronunciationRepair(seed('Healthy chapter.'))).rejects.toThrow('No pronunciation');
    expect(mocks.gemini).not.toHaveBeenCalled(); expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('requires complete valid patches and rejects English rewrite attempts before saving', async () => {
    const input = seed('The [Aetherian](/bad split/) arrived.');
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: 'Someone else' }] }) }] } }] })));
    await expect(proposePronunciationRepair(input)).rejects.toThrow('No safe repairs');
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('allows a manual targeted replacement without an AI request', async () => {
    const input = seed('God θεοῦ.');
    await proposePronunciationRepair({ ...input, manualPatches: [{ id: '0', replacement: '[θεοῦ](/θɛu/)' }] });
    expect(mocks.gemini).not.toHaveBeenCalled();
  });

  test('reports non-JSON Gemini output without echoing its body', async () => {
    mocks.fetch.mockResolvedValue(new Response('<html>private upstream body</html>'));
    await expect(proposePronunciationRepair(seed('God θεοῦ.'))).rejects.toThrow('Gemini returned invalid JSON');
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('stops before saving if cancelled', async () => {
    const input = seed('God θεοῦ.');
    const controller = new AbortController();
    controller.abort();
    await expect(proposePronunciationRepair({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(mocks.gemini).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('honors a requested model and key references for Gemini repairs', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: '[θεοῦ](/θɛu/)' }] }) }] } }] }));
    await proposePronunciationRepair({ ...seed('God θεοῦ.'), profileId: 'profile', aiModel: 'custom-selected-model', fallbackModels: ['gemini-3.6-flash'], primaryKeyRef: 'profile:primary', backupKeyRef: '' });
    expect(mocks.gemini).toHaveBeenCalledWith(expect.objectContaining({ requestedModel: 'custom-selected-model', fallbackModels: ['gemini-3.6-flash'], primaryApiKey: 'fixture', backupApiKey: '', maxAttempts: 3, retryRateLimitedModels: true, signal: expect.any(AbortSignal) }));
  });

  test('retains exact validator and per-finding reasons for rejected replacements', async () => {
    const onDiagnostics = vi.fn();
    mocks.fetch.mockResolvedValue(Response.json({ responseId: 'response-fixture', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: 'Someone else' }] }) }] } }] }));
    await expect(proposePronunciationRepair({ ...seed('The [Aetherian](/bad split/) arrived.'), onDiagnostics })).rejects.toThrow('No safe repairs');
    const details = onDiagnostics.mock.calls[0][0];
    expect(details).toMatchObject({ stage: 'patch-coverage', validatorReason: 'Repair changed unrelated English text.', finishReason: 'STOP', httpStatus: 200 });
    expect(details.findings[0]).toMatchObject({ id: '0', original: '[Aetherian](/bad split/)', replacement: 'Someone else' });
    expect(details.systemInstruction).toContain('Preserve all original words.');
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('retains omitted finding IDs and supplied patches when Gemini returns an incomplete set', async () => {
    const onDiagnostics = vi.fn();
    mocks.fetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: '{"patches":[]}' }] } }] }));
    await expect(proposePronunciationRepair({ ...seed('God θεοῦ.'), onDiagnostics })).rejects.toThrow();
    expect(onDiagnostics.mock.calls[0][0]).toMatchObject({ missingIds: ['0'], findings: [{ id: '0', original: 'θεοῦ', reasons: ['No replacement returned for this finding.'] }] });
  });

  test('restores an existing proposal and avoids another paid request', async () => {
    const input = seed('God θεοῦ.');
    mocks.selectResults = [[], [{ runId: 'existing', decision: 'pending', audioStatus: 'not_requested' }]];
    expect((await proposePronunciationRepair(input)).runId).toBe('existing');
    expect(mocks.gemini).not.toHaveBeenCalled(); expect(mocks.createRun).not.toHaveBeenCalled();
  });

  test('finds canonical and rejected chapter files, excluding originals and unrelated blobs', async () => {
    seed('God θεοῦ.'); mocks.objects.set('0108__rejected.txt', 'Broken'); mocks.objects.set('complete.m4b', 'audio');
    expect((await pronunciationCatalog('book', 'user')).chapters.map(row => row.fileName)).toEqual(['0107__text.txt', '0108__rejected.txt']);
    await expect(readPronunciationChapter('book', 'user', '../other.txt')).rejects.toThrow('Invalid');
  });

  test('retains Audio Drama voices and failed text separately from approved text', async () => {
    mocks.objects.set('0107__text.txt', 'Previous recording text.');
    await savePronunciationFailure({ bookId: 'book', userId: 'user', chapterIndex: 106, chapterTitle: 'Failed', sourceText: 'The Aetherian.', jobId: 'job', errors: ['alignment'],
      cast: [{ name: 'Narrator', voiceId: 'af_bella', aliases: [] }],
      rejected: { status: 'success', segments: [{ speaker: 'Narrator', text: 'The [Aetherian](/bad split/).' }] },
    });
    expect(mocks.put.mock.calls.map(call => call[2])).toEqual(['0107__rejected.txt', '0107__pronunciation_failure.json']);
    expect(mocks.put.mock.calls[0][3].toString()).toBe('<voice name="af_bella">The [Aetherian](/bad split/).</voice>');
    const metadata = JSON.parse(mocks.put.mock.calls[1][3].toString());
    expect(metadata.canonicalHash).toBe(batchRefineTextHash('Previous recording text.'));
    expect(metadata.sourceText).toBe('The Aetherian.');
  });

  test('refuses to resume until the approved replacement is recorded', async () => {
    const rejected = 'God θεοῦ.';
    mocks.objects.set('0107__rejected.txt', rejected);
    mocks.objects.set('0107__pronunciation_failure.json', JSON.stringify({ rejectedHash: batchRefineTextHash(rejected), sourceText: rejected, jobId: 'job' }));
    await expect(resumeRepairedPronunciationJob('book', 'user', '0107__rejected.txt')).rejects.toThrow('wait for its recording');
  });
});
