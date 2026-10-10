import { canPromoteForeignWordScanRow } from './foreign-word-source-integrity';
import { normalizeKokoroPronunciationCandidate, type PronunciationGuidanceProfile } from './kokoro-pronunciation-policy';
import type { ForeignWordScanResultRow } from './foreign-word-scan-results';

export const REVIEWED_FOREIGN_WORD_DEFAULTS_VERSION = 1;

// Small, explicit defaults for Narratum's default Erasmian/academic guidance.
// These are code-reviewed broad approximations, not an acoustic certification.
// Greek choices follow the shipped library and default vowel guidance; Hebrew
// entries are fully pointed function terms. No accent/point stripping, stemming,
// initialism inference, or OCR reconstruction is permitted for lookup.
const GREEK: Readonly<Record<string, string>> = {
  'καί': '/kaɪ/', 'καὶ': '/kaɪ/', 'δέ': '/dɛ/', 'δὲ': '/dɛ/',
  'ἐν': '/ɛn/', 'εἰς': '/eɪs/', 'ἐκ': '/ɛk/', 'οὐ': '/u/',
  'γάρ': '/ɡɑr/', 'γὰρ': '/ɡɑr/', 'μή': '/meɪ/', 'μὴ': '/meɪ/',
};
const HEBREW: Readonly<Record<string, string>> = {
  'הוּא': '/hu/', 'מִן': '/min/', 'כִּי': '/ki/',
};

export function findReviewedForeignWordDefault(row: ForeignWordScanResultRow, profile?: PronunciationGuidanceProfile | null) {
  if (profile?.pronunciationPromptMode === 'custom' || !canPromoteForeignWordScanRow(row)
      || row.ocrSuspect === true || row.ocrFragment === true || row.automaticIgnore === true
      || (Array.isArray(row.qualityFlags) && row.qualityFlags.length > 0)) return null;
  const key = row.word.normalize('NFC');
  const greek = Object.hasOwn(GREEK, key);
  const raw = greek ? GREEK[key] : Object.hasOwn(HEBREW, key) ? HEBREW[key] : null;
  const pronunciation = normalizeKokoroPronunciationCandidate(row.word, raw);
  return pronunciation ? {
    term: row.word, pronunciation, definition: null, definitionOmitted: true,
    language: greek ? 'koine_greek' as const : 'biblical_hebrew' as const,
    needsReview: false, reviewedDefaultVersion: REVIEWED_FOREIGN_WORD_DEFAULTS_VERSION,
  } : null;
}
