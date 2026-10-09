import { describe, expect, it } from 'vitest';
import { applySourceRecovery, assertRecoveredReadings, recoverScanRows, sourceRecoveryGenerationSettings, sourceRecoveryPronunciations, sourceRecoverySnapshot } from '@/lib/shared/source-recovery';
import type { SourceRecoveryAnalysis, SourceRecoveryOccurrence } from '@/types/source-recovery';

function occurrence(overrides: Partial<SourceRecoveryOccurrence> = {}): SourceRecoveryOccurrence {
  return { id: 'one', groupId: 'group', surface: 'xatagyéw', pdfPage: 1, pageSourceStart: 9,
    before: 'The word ', after: ' means abolish.', context: 'The word xatagyéw means abolish.', reasons: ['OCR'], status: 'approved',
    proposal: { correctedSurface: 'καταργέω', lemma: 'καταργέω', language: 'koine_greek', explanation: 'Reviewed page',
      dictionary: null, pronunciation: '/katɑrɡeo/', pronunciationReference: { scope: 'global', term: 'καταργέω' } }, ...overrides };
}
function analysis(occurrences = [occurrence()]): SourceRecoveryAnalysis {
  return { schemaVersion: 1, documentId: 'pdf', revision: 2, extractionVersion: 13, scannedAt: 1, occurrences, diagnostics: [] };
}
describe('document-local source recovery', () => {
  it('accepts only approved decisions in a job snapshot', () => {
    expect(sourceRecoverySnapshot(analysis([occurrence(), occurrence({ id: 'pending', status: 'proposed' })])).occurrences.map((item) => item.id)).toEqual(['one']);
  });
  it('repairs one occurrence on one page and preserves the original blocks', () => {
    const blocks = [1, 2].map((pageNumber) => ({ pageNumber, text: 'The word xatagyéw means abolish.' }));
    const result = applySourceRecovery(blocks, sourceRecoverySnapshot(analysis()), 'pdf');
    expect(result.blocks.map((item) => item.text)).toEqual(['The word καταργέω means abolish.', blocks[1].text]);
    expect(blocks[0].text).toContain('xatagyéw');
    expect(result.applied).toEqual(['one']);
  });
  it('matches whitespace wrapping across blocks while editing only the target block', () => {
    const result = applySourceRecovery([{ pageNumber: 1, text: 'The\nword' }, { pageNumber: 1, text: 'xatagyéw means\nabolish.' }], sourceRecoverySnapshot(analysis()), 'pdf');
    expect(result.blocks[1].text).toBe('καταργέω means\nabolish.');
  });
  it('recognizes a passage already repaired by the layout extractor', () => {
    const text = 'The word καταργέω means abolish.';
    const result = applySourceRecovery([{ pageNumber: 1, text }], sourceRecoverySnapshot(analysis()), 'pdf');
    expect(result.applied).toEqual(['one']); expect(result.unmatched).toEqual([]); expect(result.blocks[0].text).toBe(text);
  });
  it('refuses ambiguous repeated contexts instead of replacing every spelling', () => {
    const text = 'The word xatagyéw means abolish. The word xatagyéw means abolish.';
    const result = applySourceRecovery([{ pageNumber: 1, text }], sourceRecoverySnapshot(analysis()), 'pdf');
    expect(result.blocks[0].text).toBe(text);
    expect(result.unmatched).toEqual(['one']);
  });
  it('does not use Unicode normalization or substring replacement to find a target', () => {
    for (const text of ['The word axatagyéw means abolish.', 'The word xatagyéw means abolish.']) {
      expect(applySourceRecovery([{ pageNumber: 1, text }], sourceRecoverySnapshot(analysis()), 'pdf').applied).toEqual([]);
    }
  });
  it('rejects cross-document snapshots and conflicting overlapping approvals', () => {
    const blocks = [{ pageNumber: 1, text: 'The word xatagyéw means abolish.' }];
    expect(() => applySourceRecovery(blocks, sourceRecoverySnapshot(analysis()), 'another-pdf')).toThrow('different PDF');
    expect(() => applySourceRecovery(blocks, sourceRecoverySnapshot(analysis([occurrence(), occurrence({ id: 'duplicate' })])), 'pdf')).toThrow('overlap');
  });
  it('preserves a reviewed inflection rather than replacing it with a lemma', () => {
    const item = occurrence(); item.proposal!.correctedSurface = 'καταργούμενον';
    const result = applySourceRecovery([{ pageNumber: 1, text: item.context }], sourceRecoverySnapshot(analysis([item])), 'pdf');
    expect(result.blocks[0].text).toContain('καταργούμενον');
    expect(result.blocks[0].text).not.toContain('καταργέω');
  });
  it('rescans only accepted occurrences and retains unresolved malformed instances', () => {
    const row = { word: 'xatagyéw', count: 2, occurrences: [9, 100].map((pageSourceStart) => ({
      surfaceTerm: 'xatagyéw', pdfPage: 1, pageSourceStart, context: 'The word xatagyéw means abolish.', contextTargetStart: 9, contextTargetEnd: 17,
    })) };
    const result = recoverScanRows([row], sourceRecoverySnapshot(analysis()));
    expect(result.map((item) => [item.word, item.count])).toEqual([['καταργέω', 1], ['xatagyéw', 1]]);
    expect(row.count).toBe(2);
    expect(row.occurrences[0].surfaceTerm).toBe('xatagyéw');
  });
  it('refuses to rescan legacy truncated occurrence evidence', () => {
    const row = { word: 'xatagyéw', count: 75, occurrences: [] };
    expect(recoverScanRows([row], sourceRecoverySnapshot(analysis()))).toEqual([row]);
  });
  it('snapshots pronunciation values without creating damaged aliases', () => {
    const values = sourceRecoveryPronunciations(sourceRecoverySnapshot(analysis()));
    expect(values).toEqual({ 'καταργέω': '/katɑrɡeo/' });
    const second = occurrence({ id: 'second' }); second.proposal!.pronunciation = '/different/';
    expect(() => sourceRecoveryPronunciations(sourceRecoverySnapshot(analysis([occurrence(), second])))).toThrow('conflict');
  });
  it('requires cleanup to retain exact reviewed readings including inflections and combining marks', () => {
    const snapshot = sourceRecoverySnapshot(analysis());
    expect(() => assertRecoveredReadings('καταργέω καταργέω', '[καταργέω](/katɑrɡeo/) καταργέω', snapshot)).not.toThrow();
    expect(() => assertRecoveredReadings('καταργέω καταργέω', 'καταργέω', snapshot)).toThrow('accepted PDF');
    expect(() => assertRecoveredReadings('καταργέω', 'καταργούμενον', snapshot)).toThrow('accepted PDF');
  });
});


describe('generation snapshot boundary', () => {
  it('rejects client-supplied approvals for new runs', () => {
    expect(sourceRecoveryGenerationSettings({ settings: { voice: 'fixture', sourceRecoverySnapshot: 'forged', sourceRecoveryPronunciationSnapshot: { bogus: '/ipa/' } }, documentId: 'pdf', hasExistingChapters: false })).toEqual({ voice: 'fixture' });
  });
  it('continuing a legacy audiobook does not acquire newly accepted source changes', () => {
    const settings = sourceRecoveryGenerationSettings({ settings: {}, documentId: 'pdf', hasExistingChapters: true });
    expect(settings.sourceRecoverySnapshot).toMatchObject({ documentId: 'pdf', revision: 0, occurrences: [] });
  });
  it('continuing a book retains its original reviewed readings and exact pronunciation values', () => {
    const prior = { sourceRecoverySnapshot: sourceRecoverySnapshot(analysis()), sourceRecoveryPronunciationSnapshot: { 'καταργέω': '/katɑrɡeo/' } };
    const settings = sourceRecoveryGenerationSettings({ settings: { sourceRecoverySnapshot: 'forged' }, documentId: 'pdf', hasExistingChapters: true, previousSettings: prior });
    expect(settings).toEqual(prior);
    prior.sourceRecoverySnapshot.occurrences[0].proposal!.correctedSurface = 'changed';
    expect((settings.sourceRecoverySnapshot as typeof prior.sourceRecoverySnapshot).occurrences[0].proposal!.correctedSurface).toBe('καταργέω');
  });
  it('copies a decision snapshot independently of later analysis edits', () => {
    const document = analysis(); const snapshot = sourceRecoverySnapshot(document);
    document.occurrences[0].status = 'rejected';
    expect(snapshot.occurrences[0].status).toBe('approved');
  });
});
