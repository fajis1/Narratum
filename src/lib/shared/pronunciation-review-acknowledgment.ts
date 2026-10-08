import type { PronunciationIssue } from './pronunciation-issues';

/** Acknowledgment is local to one approved chapter version, never dictionary policy.
 * Structural/formatting findings remain actionable even for that version. */
export function unacknowledgedPronunciationIssues(
  issues: PronunciationIssue[], textHash: string, approvedOverrideTextHash?: string,
): PronunciationIssue[] {
  if (!approvedOverrideTextHash || !/^[a-f0-9]{64}$/u.test(approvedOverrideTextHash) || textHash !== approvedOverrideTextHash) return issues;
  return issues.filter(issue => issue.kind === 'structural' || issue.kind === 'formatting');
}
