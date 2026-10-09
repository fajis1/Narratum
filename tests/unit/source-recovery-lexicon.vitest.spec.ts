import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/lib/server/smart-audio/book-lexicon', () => ({ resolveSmartAudioBookLexicon: mocks.resolve }));
import { resolveSourceRecoveryLexicon } from '@/lib/server/smart-audio/source-recovery-lexicon';
import type { SourceRecoverySnapshot } from '@/types/source-recovery';
const profile = { id: 'fixture', name: 'Fixture', aiModel: 'fixture', customTtsPrompt: '', books: {}, abbreviations: {}, pronunciations: {} };
const snapshot: SourceRecoverySnapshot = { schemaVersion: 1, documentId: 'pdf', revision: 1, occurrences: [{ id: 'one', groupId: 'group', pdfPage: 1, pageSourceStart: 0, before: '', after: '', context: '', surface: 'xatagyéw', reasons: [], status: 'approved', proposal: { correctedSurface: 'καταργέω', lemma: 'καταργέω', language: 'koine_greek', explanation: '', dictionary: null, pronunciation: null, pronunciationReference: null } }] };
beforeEach(() => { vi.clearAllMocks(); mocks.resolve.mockResolvedValue({ entries: { 'καταργέω': { term: 'καταργέω', pronunciation: '/katɑrɡeo/' } } }); });
test('generates only for corrected surface terms with no available pronunciation', async () => {
  const result = await resolveSourceRecoveryLexicon({ snapshot, profile, texts: ['The word καταργέω is discussed alongside λόγος.'], knownPronunciations: {} });
  expect(result?.entries['καταργέω'].pronunciation).toBe('/katɑrɡeo/');
  expect(mocks.resolve.mock.calls[0][0].candidates).toEqual([expect.objectContaining({ term: 'καταργέω' })]);
});
test('existing valid values and omitted passages require no new provider request', async () => {
  const inputs: { texts: string[]; knownPronunciations: Record<string, string> }[] = [{ texts: ['καταργέω'], knownPronunciations: { 'καταργέω': '/katɑrɡeo/' } }, { texts: ['Other text'], knownPronunciations: {} }];
  for (const input of inputs) {
    expect(await resolveSourceRecoveryLexicon({ snapshot, profile, ...input })).toBeNull();
  }
  expect(mocks.resolve).not.toHaveBeenCalled();
});
test('unusable generation cannot silently certify a source reading as ready', async () => {
  mocks.resolve.mockResolvedValue({ entries: {} });
  await expect(resolveSourceRecoveryLexicon({ snapshot, profile, texts: ['καταργέω'], knownPronunciations: {} })).rejects.toThrow('usable document pronunciation');
});
