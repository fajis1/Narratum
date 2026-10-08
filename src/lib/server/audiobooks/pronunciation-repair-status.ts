import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { batchRefineChanges, batchRefineRuns } from '@/db/schema';
import { PRONUNCIATION_REPAIR_RULE, scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';
import type { PronunciationRepairStatus } from '@/lib/shared/pronunciation-repair-status';
import { hasPronunciationReviewOverride } from './pronunciation-repair-validation';

function approvedOverrideHash(row: { decision: string; reviewNote?: string | null; proposedTextHash?: string }) {
  return row.decision === 'approved' && hasPronunciationReviewOverride(row.reviewNote)
    && /^[a-f0-9]{64}$/u.test(row.proposedTextHash || '') ? row.proposedTextHash : undefined;
}

/** Read the latest decision for this owner's exact chapter key. Never resurrect
 * an older Override after a newer proposal/rejection has replaced it. */
export async function approvedPronunciationOverrideHash(bookId: string, userId: string, fileName: string) {
  // Rejected-text proposals are approved into the canonical text key.
  const prefix = fileName.split('__')[0];
  const [row] = await db.select({ decision: batchRefineChanges.decision, reviewNote: batchRefineChanges.reviewNote,
    proposedTextHash: batchRefineChanges.proposedTextHash,
  }).from(batchRefineChanges).innerJoin(batchRefineRuns, eq(batchRefineRuns.id, batchRefineChanges.runId)).where(and(
    eq(batchRefineChanges.documentId, bookId), eq(batchRefineChanges.userId, userId),
    inArray(batchRefineChanges.textFileName, [`${prefix}__text.txt`, `${prefix}__rejected.txt`]), eq(batchRefineRuns.rule, PRONUNCIATION_REPAIR_RULE),
  )).orderBy(desc(batchRefineChanges.createdAt), desc(batchRefineChanges.id)).limit(1);
  return row ? approvedOverrideHash(row) : undefined;
}

export async function listPronunciationRepairStatus(bookId: string, userId: string) {
  const rows: (Omit<PronunciationRepairStatus, 'ready' | 'unresolvedCount'> & { proposedText: string; proposedTextHash: string; reviewNote: string | null })[] = await db.select({
    changeId: batchRefineChanges.id, runId: batchRefineChanges.runId,
    fileName: batchRefineChanges.textFileName, chapterIndex: batchRefineChanges.chapterIndex,
    title: batchRefineChanges.chapterTitle, decision: batchRefineChanges.decision,
    audioStatus: batchRefineChanges.audioStatus, proposedText: batchRefineChanges.proposedText,
    proposedTextHash: batchRefineChanges.proposedTextHash, reviewNote: batchRefineChanges.reviewNote,
  }).from(batchRefineChanges).innerJoin(batchRefineRuns, eq(batchRefineRuns.id, batchRefineChanges.runId)).where(and(
    eq(batchRefineChanges.documentId, bookId), eq(batchRefineChanges.userId, userId),
    eq(batchRefineRuns.rule, PRONUNCIATION_REPAIR_RULE),
  )).orderBy(desc(batchRefineChanges.createdAt), desc(batchRefineChanges.id));
  const seen = new Set<number>();
  return rows.filter(row => {
    if (seen.has(row.chapterIndex)) return false;
    seen.add(row.chapterIndex);
    return true;
  }).map(({ proposedText, proposedTextHash, reviewNote, ...row }) => {
    const unresolvedCount = row.decision === 'pending' ? scanPronunciationIssues(proposedText).length : 0;
    return { ...row, unresolvedCount, ready: row.decision === 'pending' && unresolvedCount === 0,
      approvedOverrideTextHash: approvedOverrideHash({ ...row, proposedTextHash, reviewNote }) };
  });
}
