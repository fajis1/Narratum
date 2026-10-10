import { expect, test } from 'vitest';
import { FOREIGN_WORD_LANGUAGE_INSTRUCTIONS, readForeignWordLanguageMetadata, needsForeignWordLanguageReview } from '@/lib/shared/foreign-word-language';
import { getForeignWordReviewReasons } from '@/lib/shared/foreign-word-review-reasons';
import { normalizeKokoroPronunciationCandidate } from '@/lib/shared/kokoro-pronunciation-policy';
import { getForeignWordSourceRepairReasons, getSupportedSourceScripts } from '@/lib/shared/foreign-word-source-integrity';
import { exportForeignWordScan, parseForeignWordScanImportDetailed } from '@/lib/shared/foreign-word-scan-transfer';
import { validateForeignWordResultBatch, collectGeminiPronunciationRepairRequests, mergeGeminiPronunciationRepairResults } from '@/lib/server/smart-audio/gemini-foreign-word-scan';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { classifyForeignNarrationToken } from '@/lib/shared/foreign-narration-token';

test('keeps script evidence separate from contextual language, including legitimate Japanese script combinations', () => {
  expect(getSupportedSourceScripts('очи')).toEqual(['Cyrillic']);
  expect(getSupportedSourceScripts('食べる')).toEqual(['Han', 'Hiragana']);
  expect(classifyForeignNarrationToken('食べる', '食べる', 0, 3).kind).not.toBe('source_damaged');
  for (const [word, ipa] of [['очи', '/oʊtʃi/'], ['كتاب', '/kitɑb/'], ['食べる', '/tɑbɛru/']]) {
    expect(getForeignWordSourceRepairReasons(word)).toEqual([]);
    expect(normalizeKokoroPronunciationCandidate(word, ipa)).toBe(ipa);
    expect(normalizeKokoroPronunciationCandidate(word, `/${word}/`)).toBeNull();
  }
  for (const word of ['оchи', '食べaる', 'שלוםλόγος']) expect(getForeignWordSourceRepairReasons(word).length).toBeGreaterThan(0);
  expect(FOREIGN_WORD_LANGUAGE_INSTRUCTIONS).toContain('not script alone');
});

test('validates optional metadata without breaking legacy responses and persists only valid classifications', () => {
  const base = { term: 'очи', language: 'other', sourceOutcome: 'valid_word', pronunciations: ['/oʊtʃi/'],
    definition: 'eyes', definitionOmitted: false, ocrFragment: false, confidence: 0.9, needsReview: false };
  expect(validateForeignWordResultBatch(['очи'], [base])).toEqual([]);
  expect(validateForeignWordResultBatch(['очи'], [{ ...base, detectedLanguage: 'church_slavonic', languageConfidence: 0.9 }])).toEqual([]);
  for (const metadata of [{ detectedLanguage: 'invented' }, { languageConfidence: 2 }, { languageConfidence: 'certain' }, { ambiguityReason: 'guess' }]) {
    expect(() => validateForeignWordResultBatch(['очи'], [{ ...base, ...metadata }])).toThrow('Invalid language metadata');
  }
  const entries = { 'очи': { ...base, term: 'очи', pronunciation: '/oʊtʃi/', detectedLanguage: 'church_slavonic', languageConfidence: 0.9 } };
  const lexicon = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { smartAudioLexicon: {
    schemaVersion: 1, status: 'partial', profileId: 'profile', pronunciationModel: 'fixture', scannedAt: 123, entries,
  } }).smartAudioLexicon;
  expect(lexicon?.entries['очи']).toMatchObject({ detectedLanguage: 'church_slavonic', languageConfidence: 0.9 });
  expect(readForeignWordLanguageMetadata({ detectedLanguage: 'invented', languageConfidence: NaN })).toEqual({});
});

test('distinguishes language ambiguity, abbreviations, unsupported scripts, OCR and intentional omissions', () => {
  const codes = (row: { word: string; [key: string]: unknown }) => getForeignWordReviewReasons(row).map(reason => reason.code);
  expect(codes({ word: 'очи', detectedLanguage: 'unknown', ambiguityReason: 'language', sourceOutcome: 'insufficient_context' }))
    .toEqual(['ambiguous_language', 'missing_pronunciation']);
  expect(codes({ word: 'μτλ', detectedLanguage: 'unknown', ambiguityReason: 'abbreviation' })).toContain('ambiguous_abbreviation');
  expect(codes({ word: 'բառ' })).toContain('unsupported_script');
  expect(codes({ word: 'оchи', sourceStatus: 'needs_source_repair' })).toContain('source_repair');
  expect(codes({ word: 'ἐν', pronunciations: ['/ɛn/'], definitionOmitted: true, definitionNeedsReview: true })).toEqual([]);
  expect(needsForeignWordLanguageReview({ detectedLanguage: 'german', languageConfidence: 0.4 })).toBe(true);
});

test('contextual language controls Greek phonology conventions and cannot be forged through editable JSON', () => {
  expect(normalizeKokoroPronunciationCandidate('pneumatisch', '/pnoɪmɑtɪʃ/', 'german')).toBe('/pnoɪmɑtɪʃ/');
  expect(normalizeKokoroPronunciationCandidate('πνεῦμα', '/pnjumɑ/', 'koine_greek')).toBeNull();
  expect(normalizeKokoroPronunciationCandidate('πνεῦμα', '/pnjumɑ/', 'german')).toBeNull();
  expect(normalizeKokoroPronunciationCandidate('πνεύμα', '/pnɛvmɑ/', 'modern_greek')).toBe('/pnɛvmɑ/');
  const exported = exportForeignWordScan('book', [{ word: 'pneumatisch', detectedLanguage: 'german', languageConfidence: 0.9,
    libraryPronunciation: '/pnoɪmɑtɪʃ/', definition: 'pneumatic' }]);
  expect(exported.words[0]).toMatchObject({ sourceScripts: ['Latin'], detectedLanguage: 'german', currentPronunciation: '/pnoɪmɑtɪʃ/', reviewReasons: [] });
  exported.words[0].proposedPronunciation = '/pnoɪmɑtɪʃ/';
  expect(parseForeignWordScanImportDetailed(exported, 'book', new Set(['pneumatisch']), new Map(),
    { allowPartial: true, trustedLanguages: new Map([['pneumatisch', 'german']]) }).skipped).toEqual([]);
  // Upload metadata alone cannot weaken the existing pronunciation policy.
  expect(parseForeignWordScanImportDetailed(exported, 'book', new Set(['pneumatisch']), new Map(), { allowPartial: true }).skipped).toHaveLength(1);
});

test('repair requests and legacy repair responses retain contextual language guidance', () => {
  const terms = [{ term: 'pneumatisch', contexts: ['German adjective'], currentPronunciation: null }];
  const initial = { term: 'pneumatisch', detectedLanguage: 'german', languageConfidence: 0.9, pronunciations: ['/pjjɑ/'] };
  expect(collectGeminiPronunciationRepairRequests(terms, [initial])[0]).toMatchObject({ detectedLanguage: 'german', languageConfidence: 0.9 });
  expect(mergeGeminiPronunciationRepairResults([initial], [{ term: 'pneumatisch', pronunciations: ['/pnoɪmɑtɪʃ/'] }])[0])
    .toMatchObject({ detectedLanguage: 'german', pronunciations: ['/pnoɪmɑtɪʃ/'] });
});
