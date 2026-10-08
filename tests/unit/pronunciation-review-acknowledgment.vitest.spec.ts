import { expect, test } from 'vitest';
import { scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';
import { unacknowledgedPronunciationIssues } from '@/lib/shared/pronunciation-review-acknowledgment';

test('acknowledgment is version-scoped and does not change the strict scanner', () => {
  const issues = scanPronunciationIssues('[περι](/pɛr/)');
  expect(issues.length).toBeGreaterThan(0);
  const hash = 'a'.repeat(64);
  expect(unacknowledgedPronunciationIssues(issues, hash, hash)).toEqual([]);
  expect(unacknowledgedPronunciationIssues(issues, 'b'.repeat(64), hash)).toEqual(issues);
  expect(unacknowledgedPronunciationIssues(issues, hash)).toEqual(issues);
  expect(unacknowledgedPronunciationIssues(issues, 'invalid', 'invalid')).toEqual(issues);
  expect(scanPronunciationIssues('[περι](/pɛr/)')).toEqual(issues);
});

test('structural and formatting findings can never be acknowledged by Override', () => {
  const warnings = scanPronunciationIssues('[περι](/pɛr/)');
  const protectedIssues = ['structural', 'formatting'].map(kind => ({ ...warnings[0], kind: kind as 'structural' | 'formatting' }));
  const hash = 'a'.repeat(64);
  expect(unacknowledgedPronunciationIssues([...warnings, ...protectedIssues], hash, hash)).toEqual(protectedIssues);
});
