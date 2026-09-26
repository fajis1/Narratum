import { pronunciationCatalog, readPronunciationChapter, proposePronunciationRepair } from './pronunciation-repairs';
import { scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';
import { approveBatchRefineChange } from './batch-refine-review-store';
import { runTaskNow } from '@/lib/server/tasks/engine';
import { db } from '@/db';
import { batchRefineChanges } from '@/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { serverLogger } from '@/lib/server/logger';

/**
 * Runs a pronunciation repair sweep across all successfully generated chapters
 * immediately after a Smart Audio book finishes generation.
 *
 * - Chapters with no pronunciation issues are skipped (no API call made).
 * - Chapters with issues are sent through the AI repair engine.
 * - Proposals with zero remaining/unresolved findings are auto-approved and
 *   queued for re-recording so the user never has to touch them.
 * - Proposals with remaining findings are left as `pending` in the review queue
 *   for manual intervention.
 *
 * Errors are caught per-chapter so one failure never blocks the rest.
 * The function itself never throws.
 */
export async function runPostGenerationPronunciationSweep(
  bookId: string,
  userId: string,
  ownJobId: string,
  profileId?: string,
): Promise<{ swept: number; autoApproved: number; pendingReview: number; skipped: number }> {
  let swept = 0;       // chapters that had issues and were sent to the repair engine
  let autoApproved = 0; // of those, proposals fully resolved → auto-approved
  let pendingReview = 0; // proposals with remaining findings → left for the user
  let skipped = 0;     // chapters with no pronunciation issues at all

  try {
    const catalog = await pronunciationCatalog(bookId, userId);

    for (const chapter of catalog.chapters) {
      // Only sweep successfully generated chapters (__text.txt), not failures (__rejected.txt)
      if (chapter.failed) continue;

      try {
        const content = await readPronunciationChapter(bookId, userId, chapter.fileName);

        // Fast path: no pronunciation issues in this chapter — nothing to repair
        if (scanPronunciationIssues(content.text).length === 0) {
          skipped++;
          continue;
        }

        swept++;
        const controller = new AbortController();
        const proposal = await proposePronunciationRepair({
          bookId,
          userId,
          fileName: chapter.fileName,
          hash: content.hash,
          ownJobId, // allows the repair to run while the generation job is still "running"
          signal: controller.signal,
          profileId, // resolved from chapter metadata if undefined
        });

        // If the repair fully resolved every issue, auto-approve the proposal.
        // Both newly created and reused proposals are eligible as long as they're clean.
        if (proposal.unresolvedCount === 0) {
          const rows = await db.select({ id: batchRefineChanges.id })
            .from(batchRefineChanges)
            .where(and(
              eq(batchRefineChanges.runId, proposal.runId),
              eq(batchRefineChanges.userId, userId),
              eq(batchRefineChanges.documentId, bookId),
              inArray(batchRefineChanges.decision, ['pending']),
            ))
            .limit(1);

          if (rows[0]) {
            await approveBatchRefineChange({
              changeId: rows[0].id,
              userId,
              skipJobIdleCheck: true, // we are inside the generation job itself
            });
            autoApproved++;
          } else {
            // No pending change row — proposal may already be approved from a previous sweep
            skipped++;
          }
        } else {
          // Unresolved findings remain — leave for manual review
          pendingReview++;
        }
      } catch (err) {
        serverLogger.warn({
          event: 'audiobook.postsweep.chapter_error',
          error: String(err),
          bookId,
          userId,
          chapter: chapter.fileName,
        }, 'Error processing chapter during post-generation pronunciation sweep');
        pendingReview++; // conservative: count as needing review if something went wrong
      }
    }

    if (autoApproved > 0) {
      // Wake the Batch Refine recording queue so the re-TTS fires promptly
      await runTaskNow('process-batch-refine-recordings');
    }
  } catch (err) {
    serverLogger.error({
      event: 'audiobook.postsweep.fatal_error',
      error: String(err),
      bookId,
      userId,
    }, 'Fatal error in post-generation pronunciation sweep');
  }

  return { swept, autoApproved, pendingReview, skipped };
}
