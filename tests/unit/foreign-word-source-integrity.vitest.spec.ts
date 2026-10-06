import { describe, expect, test } from 'vitest';
import { classifyForeignWordSourceIntegrity, getForeignWordSourceRepairReasons,
  getSupportedSourceScripts, requiresForeignWordSourceRepair } from '@/lib/shared/foreign-word-source-integrity';
import { selectGeminiEligibleScanRows, collectGeminiPronunciationRepairRequests, normalizeGeminiOcrResults,
  validateForeignWordResultBatch } from '@/lib/server/smart-audio/gemini-foreign-word-scan';
import { getGeminiManualReviewState, isFlaggedForReview, isAutomaticallyIgnoredForeignWord,
  prepareForeignWordScanRows } from '@/lib/shared/foreign-word-scan-results';
import { exportForeignWordScan, parseForeignWordScanImportDetailed } from '@/lib/shared/foreign-word-scan-transfer';
import { normalizeKokoroPronunciationCandidate } from '@/lib/shared/kokoro-pronunciation-policy';

describe('source integrity before Gemini work', () => {
  test.each(['ויפצ', 'אבכ', 'אבמ', 'אבנ', 'אבפ', 'אבצ', 'אָבצָ', 'ךאב', 'אבץג', 'שלוםλόγος', 'ኵሎabc'])(
    'routes damaged %s to repair without changing its immutable key', (word) => {
      const original = { word, sourceStatus: 'unverified' };
      const row = classifyForeignWordSourceIntegrity(original);
      expect(row.word).toBe(word);
      expect(original.sourceStatus).toBe('unverified');
      expect(row).toMatchObject({ sourceStatus: 'needs_source_repair', sourceOutcome: 'needs_source_repair' });
      expect(isFlaggedForReview(row)).toBe(true);
      expect(isAutomaticallyIgnoredForeignWord(row)).toBe(false);
      expect(selectGeminiEligibleScanRows([row])).toEqual([]);
      expect(normalizeKokoroPronunciationCandidate(word, '/ab/')).toBeNull();
    },
  );
  test.each(['ויפץ', 'גבה', 'נרדה', 'שלום', 'לעליון', 'וראשׁו', 'ὑψωθης', 'λατρευσωσι', 'ἐπικαλεσωνται', 'ኵሎ', 'ኅቡኣተ', 'ጥበቦሙ',
    'ከከ', 'hāʾādām', 'תנ״כ', 'כ', 'ך', 'לםרבה'])(
    'does not guess corruption for legitimate/unusual %s', (word) => {
      expect(getForeignWordSourceRepairReasons(word)).toEqual([]);
    },
  );
  test('keeps repair classifications, omissions, and valid Ethiopic results in separate paths', () => {
    const rows = ['אבצ', 'ኵሎ', 'λόγος', 'שלום'].map((word) => classifyForeignWordSourceIntegrity({ word }));
    const queue = selectGeminiEligibleScanRows(rows).map((row) => row.word);
    expect(queue).toEqual(['ኵሎ', 'λόγος', 'שלום']);
    const result = { term: 'ኵሎ', pronunciations: ['/kulo/'], language: 'other', sourceOutcome: 'valid_word',
      ocrFragment: false, definition: null, definitionOmitted: true, confidence: 0.8, needsReview: false };
    expect(validateForeignWordResultBatch(queue, [result])).toEqual(['λόγος', 'שלום']);
    expect(collectGeminiPronunciationRepairRequests([{ term: 'ኵሎ', contexts: ['author transliteration'], currentPronunciation: null }], [result])).toEqual([]);
    const canonical = normalizeGeminiOcrResults([{ ...result, term: 'שלום', ocrFragment: true }, result]);
    expect(validateForeignWordResultBatch(queue, canonical)).toEqual(['λόγος']);
    const resolved = new Set(canonical.map((row) => row.term));
    expect(getGeminiManualReviewState(queue, resolved)).toEqual({ manualReviewTerms: ['λόγος'], manualReviewCount: 1 });
    expect(requiresForeignWordSourceRepair(rows[0])).toBe(true);
    expect(getSupportedSourceScripts(result.term)).toEqual(['Ethiopic']);
  });
  test('exports immutable source evidence, keeps confirmed OCR visible, and blocks guessed imports', () => {
    const rows = [classifyForeignWordSourceIntegrity({ word: 'אבצ' }),
      classifyForeignWordSourceIntegrity({ word: 'ampliﬁ', ocrFragment: true })];
    expect(prepareForeignWordScanRows(rows).every((row) => !isAutomaticallyIgnoredForeignWord(row))).toBe(true);
    const payload = exportForeignWordScan('doc', rows);
    expect(payload.version).toBe(2);
    expect(payload.words[0].word).toBe('אבצ');
    expect(payload.words[0].sourceRepairReasons!.length).toBeGreaterThan(0);
    payload.words[0].proposedPronunciation = '/ab/';
    // Historical jobs with no source status also cannot import a reconstructed reading.
    expect(parseForeignWordScanImportDetailed(payload, 'doc', new Set(['אבצ', 'ampliﬁ']), new Map(), { allowPartial: true }))
      .toMatchObject({ changes: [], skipped: [{ word: 'אבצ', reason: expect.stringContaining('source repair') }] });
  });
});
