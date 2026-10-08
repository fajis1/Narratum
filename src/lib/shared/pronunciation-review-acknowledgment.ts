import type { PronunciationIssue } from './pronunciation-issues';

export type PronunciationOverrideScanDiagnostic = {
  version: 'pronunciation-override-rescan:v1';
  requestId: string;
  status: 'matched' | 'text_changed' | 'not_approved';
  scannedText: 'saved_chapter' | 'pending_proposal';
  strictIssueCount: number;
  acknowledgedIssueCount: number;
  actionableIssueCount: number;
};

/** Acknowledgment is local to one approved chapter version, never dictionary policy.
 * Structural/formatting findings remain actionable even for that version. */
export function unacknowledgedPronunciationIssues(
  issues: PronunciationIssue[], textHash: string, approvedOverrideTextHash?: string,
): PronunciationIssue[] {
  if (!approvedOverrideTextHash || !/^[a-f0-9]{64}$/u.test(approvedOverrideTextHash) || textHash !== approvedOverrideTextHash) return issues;
  return issues.filter(issue => issue.kind === 'structural' || issue.kind === 'formatting');
}
