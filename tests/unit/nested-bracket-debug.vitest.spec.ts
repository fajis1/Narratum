import { describe, test, expect } from 'vitest';
import { scanPronunciationIssues, applyPronunciationPatches, assertPronunciationRepair } from '../../src/lib/shared/pronunciation-issues';

describe('doubled-bracket and nested-IPA repair patterns (pronunciation-repair-6.json)', () => {
  test('[[ādām](/ɑdɑm/) auto-suggests stripped replacement and accepts repair', () => {
    const text = 'And [[ādām](/ɑdɑm/) was in the garden.';
    const issues = scanPronunciationIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('formatting');
    // Scanner auto-suggests the fix
    expect(issues[0].replacement).toBe('[ādām](/ɑdɑm/)');
    const patch = { id: issues[0].id, replacement: '[ādām](/ɑdɑm/)' };
    const proposed = applyPronunciationPatches(text, issues, [patch]);
    expect(proposed).toBe('And [ādām](/ɑdɑm/) was in the garden.');
    expect(scanPronunciationIssues(proposed)).toHaveLength(0);
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
  });

  test('[[îš](/iʃ/) auto-suggests stripped replacement and accepts repair', () => {
    const text = '[[îš](/iʃ/) means man.';
    const issues = scanPronunciationIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].replacement).toBe('[îš](/iʃ/)');
    const patch = { id: issues[0].id, replacement: '[îš](/iʃ/)' };
    const proposed = applyPronunciationPatches(text, issues, [patch]);
    expect(scanPronunciationIssues(proposed)).toHaveLength(0);
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
  });

  test('[[ĕnôš](/ɛnoʊʃ/) — multiple doubled-bracket occurrences repaired', () => {
    const text = 'The word for man [[ĕnôš](/ɛnoʊʃ/) appears here and [[ādām](/ɑdɑm/) there.';
    const issues = scanPronunciationIssues(text);
    const doubled = issues.filter(i => i.text.startsWith('[['));
    expect(doubled.length).toBeGreaterThan(0);
    for (const issue of doubled) {
      expect(issue.replacement).toBe(issue.text.slice(1));
    }
    const patches = doubled.map(i => ({ id: i.id, replacement: i.text.slice(1) }));
    const proposed = applyPronunciationPatches(text, doubled, patches);
    expect(scanPronunciationIssues(proposed).filter(i => i.text.startsWith('[['))).toHaveLength(0);
  });

  test('[tām](/[tām](/tɑm/)/) auto-suggests inner tag and accepts repair without source evidence', () => {
    const text = 'Jacob was [tām](/[tām](/tɑm/)/) complete.';
    const issues = scanPronunciationIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('formatting');
    // Scanner auto-suggests collapsing the nested IPA to the inner clean tag
    expect(issues[0].replacement).toBe('[tām](/tɑm/)');
    const patch = { id: issues[0].id, replacement: '[tām](/tɑm/)' };
    const proposed = applyPronunciationPatches(text, issues, [patch]);
    expect(proposed).toBe('Jacob was [tām](/tɑm/) complete.');
    expect(scanPronunciationIssues(proposed)).toHaveLength(0);
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
  });

  test('[tām](/[tām](/tɑm/)/) assertPronunciationRepair passes without source text', () => {
    // End-to-end: the whole-chapter approval check should not require source evidence
    const previous = 'He was a [tām](/[tām](/tɑm/)/) man.';
    const proposed = 'He was a [tām](/tɑm/) man.';
    expect(() => assertPronunciationRepair(previous, proposed)).not.toThrow();
  });
});
