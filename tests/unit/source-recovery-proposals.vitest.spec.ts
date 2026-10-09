import { beforeEach, expect, test, vi } from 'vitest';
import type { SourceRecoveryAnalysis } from '@/types/source-recovery';
const mocks = vi.hoisted(() => ({ transport: vi.fn(), dictionary: vi.fn() }));
vi.mock('@/lib/server/smart-audio/gemini-failover', () => ({ fetchGeminiWithRateLimitFallback: mocks.transport }));
vi.mock('@/lib/server/smart-audio/sefaria-lexicon', () => ({ fetchLexiconEntry: mocks.dictionary }));
vi.mock('@/lib/server/documents/blobstore', () => ({ getDocumentBlob: vi.fn() }));
import { proposeSourceRecovery, validateRecoveredSurface } from '@/lib/server/smart-audio/source-recovery-proposals';
const profile = { id: 'profile', name: 'Fixture', aiModel: 'gemini-3.8-flash', geminiApiKey: 'private-fixture-key', customTtsPrompt: '', abbreviations: {}, books: {}, pronunciations: {} };
function analysis(count = 1): SourceRecoveryAnalysis {
  return { schemaVersion: 1, documentId: 'pdf', revision: 1, extractionVersion: 13, scannedAt: 1, diagnostics: [], occurrences: Array.from({ length: count }, (_, index) => ({
    id: `id-${index}`, groupId: 'group', surface: 'xatagyéw', pdfPage: index + 1, pageSourceStart: 9,
    before: 'The word ', after: ' means abolish.', context: 'The word xatagyéw means abolish.', reasons: ['OCR'], status: 'unresolved',
  })) };
}
const generated = { id: 'id-0', correctedSurface: 'καταργούμενον', lemma: 'καταργέω', language: 'koine_greek', pronunciation: '/katɑrɡumenon/', explanation: 'Printed inflection on page' };
const renderer = vi.fn(async (): Promise<{ page: number; kind: 'page' | 'crop'; cropKind?: 'text_block'; occurrenceId?: string; data: string }[]> => [
  { page: 1, kind: 'page', data: 'fixture-image' },
]);
const dictionary = vi.fn(async () => ({ headword: 'καταργέω', source: 'perseus', morphology: 'participle', definitions: ['abolish'] }));
function response(results: unknown, status = 200) {
  mocks.transport.mockResolvedValue({ response: new Response(JSON.stringify(status === 200 ? { candidates: [{ content: { parts: [{ text: JSON.stringify(results) }] } }] } : { error: { message: 'private-fixture-key' } }), { status }), usedModel: 'fixture-model' });
}
beforeEach(() => { vi.clearAllMocks(); renderer.mockResolvedValue([{ page: 1, kind: 'page', data: 'fixture-image' }]); response([generated]); });
test('preserves inflected surface independently of lemma and checks that surface in the dictionary', async () => {
  const input = analysis();
  const next = await proposeSourceRecovery({ analysis: input, groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer, dictionary });
  expect(next.occurrences[0]).toMatchObject({ status: 'proposed', proposal: { correctedSurface: 'καταργούμενον', lemma: 'καταργέω', visualEvidence: 'full_page_unlocalized', dictionary: { morphology: 'participle' } } });
  expect(dictionary).toHaveBeenCalledWith('καταργούμενον', 'koine_greek');
  expect(input.occurrences[0].status).toBe('unresolved');
  expect(next.diagnostics[0]).toMatchObject({ attempted: true, outcome: 'proposed' });
});
test('uses dictionary pronunciation snapshots instead of silently modifying the library', async () => {
  const library = { 'καταργούμενον': '/katɑrɡumenon/' };
  const next = await proposeSourceRecovery({ analysis: analysis(), groupId: 'group', profile, globalPronunciations: library }, { renderPages: renderer, dictionary });
  expect(next.occurrences[0].proposal).toMatchObject({ pronunciation: '/katɑrɡumenon/', pronunciationReference: { scope: 'global', term: 'καταργούμενον' } });
  expect(library).toEqual({ 'καταργούμενον': '/katɑrɡumenon/' });
});
test('rejects wrong IDs, duplicate IDs, invalid spellings and incomplete results atomically', async () => {
  for (const results of [[{ ...generated, id: 'unknown' }], [{ ...generated, correctedSurface: '<injection>' }], [], [generated, generated]]) {
    response(results);
    const next = await proposeSourceRecovery({ analysis: analysis(), groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer, dictionary });
    expect(next.occurrences[0].status).toBe('unresolved');
    expect(next.diagnostics[0].outcome).toBe('validation_rejected');
  }
});
test('does not attach a Greek dictionary lookup to a mismatched Hebrew classification', async () => {
  response([{ ...generated, language: 'biblical_hebrew' }]);
  const next = await proposeSourceRecovery({ analysis: analysis(), groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer, dictionary });
  expect(next.occurrences[0].status).toBe('unresolved');
  expect(next.diagnostics[0].outcome).toBe('validation_rejected');
  expect(dictionary).not.toHaveBeenCalled();
});
test('records HTTP failures without recording provider messages or credentials', async () => {
  response(null, 429);
  const next = await proposeSourceRecovery({ analysis: analysis(), groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer });
  expect(next.diagnostics[0]).toMatchObject({ attempted: true, outcome: 'provider_error', httpStatus: 429 });
  expect(JSON.stringify(next)).not.toContain('private-fixture-key');
});
test('distinguishes rendering failures from attempted Gemini requests', async () => {
  renderer.mockRejectedValueOnce(new Error('private local path'));
  const next = await proposeSourceRecovery({ analysis: analysis(), groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer });
  expect(mocks.transport).not.toHaveBeenCalled();
  expect(next.diagnostics[0]).toMatchObject({ attempted: false, outcome: 'provider_error' });
  expect(JSON.stringify(next)).not.toContain('private local path');
});
test('keeps ambiguous readings explicitly unresolved from further auto-retry and advances the next bounded batch', async () => {
  const current = analysis(75);
  response(current.occurrences.slice(0, 6).map((item) => ({ id: item.id, correctedSurface: null })));
  const next = await proposeSourceRecovery({ analysis: current, groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer });
  expect(renderer).toHaveBeenCalledWith('pdf', [1, 2, 3, 4, 5, 6].map((page, index) => ({
    page, bbox: undefined, occurrenceId: `id-${index}`,
  })), null);
  expect(next.occurrences.slice(0, 6).every((item) => item.status === 'ambiguous' && item.analyzedAt)).toBe(true);
  response(current.occurrences.slice(6, 12).map((item) => ({ id: item.id, correctedSurface: null })));
  await proposeSourceRecovery({ analysis: next, groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer });
  expect(renderer).toHaveBeenLastCalledWith('pdf', [7, 8, 9, 10, 11, 12].map((page, index) => ({
    page, bbox: undefined, occurrenceId: `id-${index + 6}`,
  })), null);
});
test('uses per-occurrence target crops when the scanner provides reliable PDF coordinates', async () => {
  const input = analysis();
  input.occurrences[0].bbox = [20, 30, 50, 42];
  renderer.mockResolvedValueOnce([
    { page: 1, kind: 'page', data: 'page-image' },
    { page: 1, kind: 'crop', cropKind: 'text_block', occurrenceId: 'id-0', data: 'target-crop' },
  ]);
  const next = await proposeSourceRecovery({ analysis: input, groupId: 'group', profile, globalPronunciations: {} }, { renderPages: renderer, dictionary });
  expect(next.occurrences[0].proposal?.visualEvidence).toBe('text_block_crop_provided');
  expect(renderer).toHaveBeenCalledWith('pdf', [{ page: 1, bbox: [20, 30, 50, 42], occurrenceId: 'id-0' }], null);
});
test('rejects mixed scripts, markup, digits and nonfinal Greek sigma in recovered readings', () => {
  for (const value of ['ἡgούμενοι', 'de50Eaopévovy', '<word>', 'two words', 'λογοσ']) expect(() => validateRecoveredSurface(value)).toThrow();
  expect(validateRecoveredSurface('καταργούμενον')).toBe('καταργούμενον');
  expect(validateRecoveredSurface('חֶסֶד')).toBe('חֶסֶד');
});
