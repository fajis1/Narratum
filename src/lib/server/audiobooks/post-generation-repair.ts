import { pronunciationCatalog, readPronunciationChapter, proposePronunciationRepair } from './pronunciation-repairs';
import { scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';
import { approveBatchRefineChange } from './batch-refine-review-store';
import { runTaskNow } from '@/lib/server/tasks/engine';
import { db } from '@/db';
import { batchRefineChanges } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { serverLogger } from '@/lib/server/logger';

export async function runPostGenerationPronunciationSweep(
  bookId: string,
  userId: string,
  ownJobId: string,
  profileId?: string,
): Promise<{ swept: number; autoApproved: number; pendingReview: number; skipped: number }> {
  let swept = 0;
  let autoApproved = 0;
  let pendingReview = 0;
  let skipped = 0;

  try {
    const catalog = await pronunciationCatalog(bookId, userId);
    
    for (const chapter of catalog.chapters) {
      if (chapter.failed === false) { // only process success cases (i.e. __text.txt)
        swept++;
        try {
          const content = await readPronunciationChapter(bookId, userId, chapter.fileName);
          const issues = scanPronunciationIssues(content.text);
          
          if (issues.length === 0) {
            skipped++;
            continue;
          }
          
          const controller = new AbortController();
          const proposal = await proposePronunciationRepair({
            bookId,
            userId,
            fileName: chapter.fileName,
            hash: content.hash,
            ownJobId,
            signal: controller.signal,
            aiModel: undefined, // let it resolve
            profileId, // Note: passing this as profileId
          });
          
          if (proposal.unresolvedCount === 0 && proposal.proposalAction !== 'reused') {
            const rows = await db.select({ id: batchRefineChanges.id })
              .from(batchRefineChanges)
              .where(and(
                eq(batchRefineChanges.runId, proposal.runId),
                eq(batchRefineChanges.userId, userId),
                eq(batchRefineChanges.documentId, bookId),
                eq(batchRefineChanges.decision, 'pending'),
              ))
              .limit(1);
            
            if (rows[0]) {
              await approveBatchRefineChange({
                changeId: rows[0].id,
                userId,
                skipJobIdleCheck: true
              });
              autoApproved++;
            } else {
              pendingReview++;
            }
          } else if (proposal.unresolvedCount === 0 && proposal.proposalAction === 'reused') {
            // Already resolved and reused
            const rows = await db.select({ id: batchRefineChanges.id, decision: batchRefineChanges.decision })
              .from(batchRefineChanges)
              .where(and(
                eq(batchRefineChanges.runId, proposal.runId),
                eq(batchRefineChanges.userId, userId),
                eq(batchRefineChanges.documentId, bookId),
              ))
              .limit(1);
            
            if (rows[0] && rows[0].decision === 'pending') {
               await approveBatchRefineChange({
                 changeId: rows[0].id,
                 userId,
                 skipJobIdleCheck: true
               });
               autoApproved++;
            } else {
               skipped++; // Reused and not pending (maybe already approved or doesn't have a change object)
            }
          } else {
            pendingReview++;
          }
        } catch (err) {
          serverLogger.warn({ event: 'audiobook.postsweep.chapter_error', error: String(err), bookId, userId, chapter: chapter.fileName }, 'Error processing chapter during pronunciation sweep');
          pendingReview++; // fallback: assume it needs review if it crashes
        }
      }
    }
    
    if (autoApproved > 0) {
      await runTaskNow('process-batch-refine-recordings');
    }
  } catch (err) {
    serverLogger.error({ event: 'audiobook.postsweep.fatal_error', error: String(err), bookId, userId }, 'Fatal error in pronunciation sweep');
  }

  return { swept, autoApproved, pendingReview, skipped };
}
