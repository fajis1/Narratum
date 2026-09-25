import { describe, expect, test } from 'vitest';
import {
  getAutomaticForeignWordIgnoreReason,
  isAutomaticallyIgnoredForeignWord,
  isFlaggedForReview,
  isLowValueForeignFunctionTerm,
  isMissingPronunciation,
  prepareForeignWordScanRows,
  sortForeignWordScanRows,
} from '@/lib/shared/foreign-word-scan-results';

describe('foreign-word scan result preparation', () => {
  test('ignores only deterministic extraction artifacts and retains complete words', () => {
    for (const artifact of [
      'δ᾽',
      'σ᾿',
      'οὐσ',
      'דמותὁμοίωμα',
      'מהτί',
      'σχ',
      'κλ',
      'θεός·',
    ]) {
      expect(getAutomaticForeignWordIgnoreReason(artifact), artifact).toBeTruthy();
    }
    for (const word of ['Θεσμοφόρος', 'θεῷ', 'εἶναι', 'Χριστός', 'θεοῦ']) {
      expect(getAutomaticForeignWordIgnoreReason(word), word).toBeNull();
    }
  });

  test('hides low-value function terms without treating content words as artifacts', () => {
    for (const term of ['τὸ', 'καὶ', 'τὴν', 'δὲ', 'κατὰ']) {
      expect(isLowValueForeignFunctionTerm(term), term).toBe(true);
    }
    expect(isLowValueForeignFunctionTerm('Θεσμοφόρος')).toBe(false);
    const [functionRow, contentRow] = prepareForeignWordScanRows([
      { word: 'τὸ', count: 802, pronunciations: ['/toʊ/'] },
      { word: 'Θεσμοφόρος', count: 2, pronunciations: [] },
    ]);
    expect(isAutomaticallyIgnoredForeignWord(functionRow)).toBe(true);
    expect(isAutomaticallyIgnoredForeignWord(contentRow)).toBe(false);
  });

  test('rebuilds accent-insensitive fuzzy groups and sorts by combined frequency', () => {
    const prepared = prepareForeignWordScanRows([
      { word: 'Θεσμοφόρος', count: 800, pronunciations: ['/valid/'] },
      { word: 'ἁρπαγμός', count: 664, pronunciations: ['/one/'] },
      { word: 'ἅρπαγμα', count: 214, pronunciations: ['/two/'] },
    ]);
    const harpagmos = prepared.find((row) => row.word === 'ἁρπαγμός');
    expect(harpagmos?.fuzzyGroupCount).toBe(878);
    expect(harpagmos?.fuzzyGroupVariants).toEqual(['ἁρπαγμός', 'ἅρπαγμα']);
    expect(sortForeignWordScanRows(prepared).map((row) => row.word))
      .toEqual(['ἁρπαγμός', 'ἅρπαγμα', 'Θεσμοφόρος']);
  });

  test('does not chain indirect fuzzy matches into one group', () => {
    const prepared = prepareForeignWordScanRows([
      { word: 'Aaaa', count: 3, pronunciations: [] },
      { word: 'Aabb', count: 2, pronunciations: [] },
      { word: 'Bbbb', count: 1, pronunciations: [] },
    ]);
    const byWord = Object.fromEntries(prepared.map((row) => [row.word, row]));

    expect(byWord.Aaaa.fuzzyGroupCount).toBe(5);
    expect(byWord.Aaaa.fuzzyGroupVariants).toEqual(['Aaaa', 'Aabb']);
    expect(byWord.Bbbb.fuzzyGroupCount).toBe(1);
    expect(byWord.Bbbb.fuzzyGroupVariants).toEqual(['Bbbb']);
  });

  test('uses missing-first only when the user explicitly enables it', () => {
    const prepared = prepareForeignWordScanRows([
      { word: 'λόγος', count: 20, pronunciations: ['/loɡos/'] },
      { word: 'Θεσμοφόρος', count: 2, pronunciations: [] },
    ]);
    expect(sortForeignWordScanRows(prepared)[0].word).toBe('λόγος');
    expect(sortForeignWordScanRows(prepared, { pinMissingFirst: true })[0].word)
      .toBe('Θεσμοφόρος');
  });

  test('correctly identifies rows flagged for review', () => {
    expect(isFlaggedForReview({ word: 'test', importWarning: 'Invalid Kokoro pronunciation for test.' })).toBe(true);
    expect(isFlaggedForReview({ word: 'test', definitionNeedsReview: true })).toBe(true);
    expect(isFlaggedForReview({ word: 'test', sourceStatus: 'needs_source_repair' })).toBe(true);
    expect(isFlaggedForReview({ word: 'test', sourceOutcome: 'needs_source_repair' })).toBe(true);
    expect(isFlaggedForReview({ word: 'test', sourceStatus: 'source_review_recommended' })).toBe(true);
    expect(isFlaggedForReview({ word: 'test', sourceOutcome: 'insufficient_context' })).toBe(true);
    expect(isFlaggedForReview({ word: 'test', qualityFlags: ['import_validation_failed'] })).toBe(true);
    expect(isFlaggedForReview({ word: 'test', pronunciations: ['/test/'] })).toBe(false);
  });

  test('correctly identifies missing pronunciations', () => {
    expect(isMissingPronunciation({ word: 'test' })).toBe(true);
    expect(isMissingPronunciation({ word: 'test', pronunciations: [] })).toBe(true);
    expect(isMissingPronunciation({ word: 'test', pronunciations: ['/test/'] })).toBe(false);
    expect(isMissingPronunciation({ word: 'test', pronunciations: [], userOverride: '/override/' })).toBe(false);
  });
});
