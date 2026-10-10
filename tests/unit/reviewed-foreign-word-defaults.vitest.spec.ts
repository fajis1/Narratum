import { expect, test } from 'vitest';
import { findReviewedForeignWordDefault } from '@/lib/shared/reviewed-foreign-word-defaults';

test('looks up exact function terms with valid pronunciations and omitted glosses', () => {
  for (const word of ['καί', 'καὶ', 'δέ', 'δὲ', 'ἐν', 'εἰς', 'ἐκ', 'οὐ', 'γάρ', 'γὰρ', 'μή', 'μὴ', 'הוּא', 'מִן', 'כִּי']) {
    expect(findReviewedForeignWordDefault({ word })).toMatchObject({ term: word, definition: null, definitionOmitted: true,
      needsReview: false, reviewedDefaultVersion: 1 });
  }
  const decomposed = 'καί'.normalize('NFD');
  expect(findReviewedForeignWordDefault({ word: decomposed })?.term).toBe(decomposed);
});

test('does not strip accents or pointing, infer initials, or apply defaults to custom guidance', () => {
  for (const word of ['και', 'Καί', 'ἐν192', 'θεός', 'הוא', 'מן', 'κτλ', 'κ.τ.λ.', 'ἐνfoo']) {
    expect(findReviewedForeignWordDefault({ word })).toBeNull();
  }
  expect(findReviewedForeignWordDefault({ word: 'καί' }, { pronunciationPromptMode: 'custom' })).toBeNull();
});

test('retains source review for every form of OCR or document-recovery evidence', () => {
  for (const evidence of [
    { sourceStatus: 'needs_source_repair' }, { sourceStatus: 'source_review_recommended' },
    { sourceStatus: 'verified_document_reading' }, { sourceOutcome: 'insufficient_context' },
    { sourceRecoveryCounts: { applied: 1 } }, { latinizedOcrCandidate: true },
    { ocrSuspect: true }, { ocrFragment: true }, { qualityFlags: ['detached_combining_mark'] },
  ]) expect(findReviewedForeignWordDefault({ word: 'καί', ...evidence })).toBeNull();
});
