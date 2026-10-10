import { getSupportedSourceScripts, hasUnsupportedSourceLetters, requiresForeignWordSourceRepair } from './foreign-word-source-integrity';
import { needsForeignWordLanguageReview, readForeignWordLanguageMetadata } from './foreign-word-language';
import { normalizeKokoroPronunciationCandidate } from './kokoro-pronunciation-policy';

export type ForeignWordReviewReason = { code: string; message: string };

/** Compute from current evidence, including legacy scans; imported labels are never authoritative. */
export function getForeignWordReviewReasons(row: { word: string; [key: string]: unknown }): ForeignWordReviewReason[] {
  const reasons: ForeignWordReviewReason[] = [];
  if (getSupportedSourceScripts(row.word).length === 0 || hasUnsupportedSourceLetters(row.word)) {
    reasons.push({ code: 'unsupported_script', message: 'Source writing system is not supported yet.' });
  }
  if (requiresForeignWordSourceRepair(row) || row.ocrFragment === true) {
    reasons.push({ code: 'source_repair', message: 'Verify and repair the extracted text against the PDF.' });
  } else if (row.sourceStatus === 'source_review_recommended') {
    reasons.push({ code: 'source_review', message: 'Check the printed word and surrounding passage.' });
  }
  const metadata = readForeignWordLanguageMetadata(row);
  if (needsForeignWordLanguageReview(metadata)) {
    reasons.push(metadata.ambiguityReason === 'abbreviation'
      ? { code: 'ambiguous_abbreviation', message: 'Context does not establish how to read this abbreviation.' }
      : { code: 'ambiguous_language', message: 'Context does not establish the language reliably.' });
  } else if (row.sourceOutcome === 'insufficient_context') {
    reasons.push({ code: 'missing_context', message: 'More context is needed for a reliable reading.' });
  }
  if (row.importWarning) reasons.push({ code: 'import_failed', message: String(row.importWarning) });
  if (row.automaticIgnore !== true && row.sourceOutcome !== 'not_applicable') {
    const candidates = [row.userOverride, row.libraryPronunciation, row.geminiRecommendedPronunciation,
      ...(Array.isArray(row.pronunciations) ? row.pronunciations.map((choice) =>
        typeof choice === 'string' ? choice : choice && typeof choice === 'object' ? choice.phonetic : null) : [])];
    if (!candidates.some((value) => normalizeKokoroPronunciationCandidate(row.word, value, metadata.detectedLanguage))) {
      reasons.push({ code: candidates.some(Boolean) ? 'invalid_pronunciation' : 'missing_pronunciation',
        message: candidates.some(Boolean) ? 'Stored pronunciation does not pass compatibility checks.' : 'No usable pronunciation is saved.' });
    }
    if (row.definitionNeedsReview === true && row.definitionOmitted !== true && !row.definition) {
      reasons.push({ code: 'missing_definition', message: 'Contextual definition has not been resolved.' });
    }
  }
  return reasons;
}
