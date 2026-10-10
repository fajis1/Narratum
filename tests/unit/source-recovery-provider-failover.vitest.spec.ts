import { beforeEach, expect, test, vi } from 'vitest';
import { proposeSourceRecovery } from '@/lib/server/smart-audio/source-recovery-proposals';
import { SourceRecoveryStageError } from '@/lib/server/smart-audio/source-recovery-errors';
import type { SourceRecoveryAnalysis } from '@/types/source-recovery';

vi.mock('@/lib/server/smart-audio/sefaria-lexicon', () => ({ fetchLexiconEntry: vi.fn(async () => null) }));
vi.mock('@/lib/server/documents/blobstore', () => ({ getDocumentBlob: vi.fn() }));
const profile = { id: 'saved-profile', name: 'Scholar fixture', aiModel: 'gemini-3.8-flash',
  pronunciationAiModelFallbacks: ['gemini-3.7-flash'], geminiApiKey: 'private-primary-fixture', backupGeminiApiKey: 'private-backup-fixture',
  customTtsPrompt: '', abbreviations: {}, books: {}, pronunciations: {} };
function analysis(): SourceRecoveryAnalysis {
  return { schemaVersion: 1, documentId: 'fixture-pdf', revision: 1, extractionVersion: 13, scannedAt: 1, diagnostics: [],
    occurrences: [{ id: 'target', groupId: 'group', surface: 'xatagyéw', pdfPage: 14, pageSourceStart: 10,
      before: 'word ', after: ' means', context: 'word xatagyéw means', reasons: ['OCR'], status: 'unresolved' },
    { id: 'reviewed', groupId: 'group', surface: 'xatagyéw', pdfPage: 15, pageSourceStart: 10,
      before: 'word ', after: ' means', context: 'word xatagyéw means', reasons: ['OCR'], status: 'approved', reviewedAt: 1,
      proposal: { correctedSurface: 'καταργέω', lemma: 'καταργέω', language: 'koine_greek', explanation: 'Reviewed fixture', dictionary: null, pronunciation: null, pronunciationReference: null } }] };
}
function success() {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([
    { id: 'target', correctedSurface: 'καταργούμενον', lemma: 'καταργέω', language: 'koine_greek', explanation: 'Fixture printed inflection' },
  ]) }] } }] }), { status: 200 });
}
const renderer = vi.fn(async () => [{ page: 14, kind: 'page' as const, data: 'fixture-image' }]);
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock); renderer.mockResolvedValue([{ page: 14, kind: 'page', data: 'fixture-image' }]); });
const run = (extra: Partial<Parameters<typeof proposeSourceRecovery>[0]> = {}) => proposeSourceRecovery({ analysis: analysis(), groupId: 'group', profile, globalPronunciations: {}, ...extra }, { renderPages: renderer });
const roles = () => fetchMock.mock.calls.map(([, init]) => (init!.headers as Record<string, string>)['x-goog-api-key']);

test('records actual primary model failures and successful saved backup without exposing secrets', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(success());
  const next = await run();
  expect(roles()).toEqual([profile.geminiApiKey, profile.geminiApiKey, profile.backupGeminiApiKey]);
  const diagnostic = next.diagnostics.at(-1)!;
  expect(diagnostic).toMatchObject({ outcome: 'proposed', usedBackup: true, httpStatus: 200, configuration: { profileId: profile.id, model: profile.aiModel, fallbackModels: ['gemini-3.7-flash'] } });
  expect(diagnostic.attempts?.map(a => [a.keyRole, a.model, a.httpStatus, a.fallbackAttempted])).toEqual([
    ['primary', 'gemini-3.8-flash', 429, true], ['primary', 'gemini-3.7-flash', 503, true], ['backup', 'gemini-3.8-flash', 200, false],
  ]);
  expect(next.occurrences[0]).toMatchObject({ status: 'proposed', pdfPage: 14, proposal: { correctedSurface: 'καταργούμενον', lemma: 'καταργέω' } });
  expect(next.occurrences[1]).toEqual(analysis().occurrences[1]);
  for (const key of [profile.geminiApiKey, profile.backupGeminiApiKey]) expect(JSON.stringify(next)).not.toContain(key);
});

test.each([429, 500, 502, 503, 504])('HTTP %i uses bounded eligible fallback and retains its status', async status => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(success());
  const next = await run();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(next.diagnostics.at(-1)?.attempts?.[0]).toMatchObject({ httpStatus: status, retryable: true, fallbackAttempted: true });
});

test('per-request timeout tries the configured models then the backup key', async () => {
  fetchMock.mockRejectedValueOnce(new DOMException('private-primary-fixture', 'TimeoutError'))
    .mockRejectedValueOnce(new DOMException('private-primary-fixture', 'TimeoutError')).mockResolvedValueOnce(success());
  const next = await run();
  expect(roles()).toEqual([profile.geminiApiKey, profile.geminiApiKey, profile.backupGeminiApiKey]);
  expect(next.diagnostics.at(-1)?.attempts?.slice(0, 2).every(a => a.stage === 'gemini_timeout' && a.errorCategory === 'timeout' && a.retryable)).toBe(true);
  expect(next.diagnostics.at(-1)?.usedBackup).toBe(true);
});

test('empty profile fallbacks use the shared built-in model sequence', async () => {
  fetchMock.mockImplementation(async (_url, init) => (init!.headers as Record<string, string>)['x-goog-api-key'] === profile.backupGeminiApiKey ? success() : new Response(null, { status: 503 }));
  const next = await run({ profile: { ...profile, pronunciationAiModelFallbacks: [] } });
  expect(next.diagnostics.at(-1)?.attempts?.map(a => [a.keyRole, a.model])).toEqual([
    ['primary', 'gemini-3.8-flash'], ['primary', 'gemini-3.7-flash'], ['primary', 'gemini-3.6-flash'], ['backup', 'gemini-3.8-flash'],
  ]);
});

test('timeout while reading an HTTP 200 body receives failover and retains the known HTTP status', async () => {
  const stalled = new Response('fixture body');
  vi.spyOn(stalled, 'text').mockRejectedValueOnce(new DOMException('private transport detail', 'TimeoutError'));
  fetchMock.mockResolvedValueOnce(stalled).mockResolvedValueOnce(success());
  const next = await run();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(next.diagnostics.at(-1)).toMatchObject({ outcome: 'proposed', attempts: [
    expect.objectContaining({ stage: 'gemini_timeout', httpStatus: 200, errorCategory: 'timeout', retryable: true, fallbackAttempted: true }),
    expect.objectContaining({ outcome: 'success' }),
  ] });
  expect(JSON.stringify(next)).not.toContain('private transport detail');
});

test.each([401, 402, 403])('permanent HTTP %i stops with configuration diagnostics', async status => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: profile.geminiApiKey } }), { status }));
  const next = await run();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(next.diagnostics.at(-1)).toMatchObject({ stage: 'gemini_configuration', outcome: 'configuration_error', retryable: false, httpStatus: status });
  expect(next.occurrences).toEqual(analysis().occurrences);
});

test('long Retry-After yields without exhausting the model/key chain', async () => {
  fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '600' } }));
  const next = await run();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(next.diagnostics.at(-1)).toMatchObject({ outcome: 'provider_error', retryable: true, retryAfterMs: 600_000, usedBackup: false });
  expect(next.diagnostics.at(-1)?.attempts?.[0].fallbackAttempted).toBe(false);
});

test('repeated network failures exhaust a finite request budget and preserve reviewed evidence', async () => {
  fetchMock.mockRejectedValue(new TypeError('private-backup-fixture'));
  const next = await run({ profile: { ...profile, pronunciationAiModelFallbacks: [] } });
  expect(fetchMock).toHaveBeenCalledTimes(6);
  expect(next.diagnostics.at(-1)).toMatchObject({ stage: 'gemini_request', outcome: 'provider_error', retryable: true });
  expect(next.occurrences).toEqual(analysis().occurrences);
  expect(JSON.stringify(next)).not.toContain('private-backup-fixture');
});

test.each(['pdf_loading', 'pdf_rendering', 'renderer_startup'] as const)('%s failure records zero Gemini requests', async stage => {
  renderer.mockRejectedValueOnce(new SourceRecoveryStageError(stage, 'Could not render the PDF page. Gemini was not contacted.', new Error('private path')));
  const next = await run();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(next.diagnostics.at(-1)).toMatchObject({ stage, outcome: 'renderer_error', attempted: false, attempts: [] });
  expect(JSON.stringify(next)).not.toContain('private path');
});

test('HTTP 200 invalid JSON reports parsing failure instead of provider outage', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{bad-json' }] } }] })));
  const next = await run();
  expect(next.diagnostics.at(-1)).toMatchObject({ outcome: 'validation_rejected', stage: 'response_parsing', httpStatus: 200 });
  expect(next.occurrences).toEqual(analysis().occurrences);
});

test('explicit cancellation stops before another model or key is attempted', async () => {
  const controller = new AbortController();
  fetchMock.mockImplementationOnce(async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); });
  const next = await run({ signal: controller.signal });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(next.diagnostics.at(-1)).toMatchObject({ outcome: 'cancelled', retryable: false, attempts: [expect.objectContaining({ outcome: 'cancelled' })] });
  expect(next.occurrences).toEqual(analysis().occurrences);
});

test('backup override uses only the server-saved backup credential without changing the profile', async () => {
  fetchMock.mockResolvedValue(success());
  const next = await run({ useBackupKey: true });
  expect(roles()).toEqual([profile.backupGeminiApiKey]);
  expect(next.diagnostics.at(-1)).toMatchObject({ usedBackup: true, attempts: [expect.objectContaining({ keyRole: 'backup' })] });
  expect(profile.geminiApiKey).toBe('private-primary-fixture');
});

test('dictionary outage retains visual proposals as dictionary-unverified without discarding approvals', async () => {
  fetchMock.mockResolvedValue(success());
  const next = await proposeSourceRecovery({ analysis: analysis(), groupId: 'group', profile, globalPronunciations: {} }, {
    renderPages: renderer, dictionary: vi.fn(async () => { throw new Error('private dictionary error'); }),
  });
  expect(next.diagnostics[0]).toMatchObject({ outcome: 'dictionary_warning', stage: 'dictionary_lookup' });
  expect(next.diagnostics.at(-1)?.outcome).toBe('proposed');
  expect(next.occurrences[0]).toMatchObject({ status: 'proposed', proposal: { dictionary: null } });
  expect(next.occurrences[1]).toEqual(analysis().occurrences[1]);
});
