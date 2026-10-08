import { NextResponse } from 'next/server';

import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  approveBatchRefineChange,
  BatchRefineReviewConflictError,
  getBatchRefineReview,
  listPendingBatchRefineChanges,
  reopenBatchRefineChange,
  rejectBatchRefineChange,
  retryBatchRefineRecording,
} from '@/lib/server/audiobooks/batch-refine-review-store';
import { runTaskNow } from '@/lib/server/tasks/engine';
import { errorResponse } from '@/lib/server/errors/next-response';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

function wakeRecordingQueue(): void {
  void runTaskNow('process-batch-refine-recordings').catch((error) => {
    serverLogger.warn({
      event: 'audiobook.batch_refine.recording_wake_failed',
      error: errorToLog(error),
    }, 'Failed to wake the Batch Refine recording queue');
  });
}

export async function GET(request: Request) {
  try {
    const ctx = await requireAuthContext(request);
    if (ctx instanceof Response) return ctx;
    if (!ctx.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(request.url);
    const bookId = url.searchParams.get('bookId');
    const runId = url.searchParams.get('runId');
    if (!bookId) return NextResponse.json({ error: 'bookId is required' }, { status: 400 });

    return NextResponse.json(await getBatchRefineReview({
      userId: ctx.userId,
      documentId: bookId,
      runId,
    }));
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'audiobook.batch_refine.review_load_failed',
      msg: 'Batch Refine review could not be loaded',
      apiErrorMessage: 'Batch Refine review could not be loaded.',
      normalize: { code: 'BATCH_REFINE_REVIEW_LOAD_FAILED', errorClass: 'db' },
    });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAuthContext(request);
    if (ctx instanceof Response) return ctx;
    if (!ctx.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json() as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';
    const changeId = typeof body.changeId === 'string' ? body.changeId : '';
    const recordingVoice = typeof body.recordingVoice === 'string' ? body.recordingVoice : undefined;

    if (action === 'approve') {
      if (!changeId) return NextResponse.json({ error: 'changeId is required' }, { status: 400 });
      const editedText = typeof body.editedText === 'string' ? body.editedText : undefined;
      const overrideIssueIds = Array.isArray(body.overrideIssueIds)
        ? body.overrideIssueIds.filter((value): value is string => typeof value === 'string')
        : undefined;
      const result = await approveBatchRefineChange({ changeId, userId: ctx.userId, editedText, overrideSourceEvidence: body.overrideSourceEvidence === true, overrideIssueIds, overrideFullManualEdit: body.overrideFullManualEdit === true, overridePronunciationReview: body.overridePronunciationReview === true, recordingVoice });
      wakeRecordingQueue();
      return NextResponse.json({ success: true, ...result });
    }

    if (action === 'reject') {
      if (!changeId) return NextResponse.json({ error: 'changeId is required' }, { status: 400 });
      await rejectBatchRefineChange(changeId, ctx.userId);
      return NextResponse.json({ success: true });
    }

    if (action === 'reopen') {
      if (!changeId) return NextResponse.json({ error: 'changeId is required' }, { status: 400 });
      await reopenBatchRefineChange(changeId, ctx.userId);
      return NextResponse.json({ success: true });
    }

    if (action === 'retry') {
      if (!changeId) return NextResponse.json({ error: 'changeId is required' }, { status: 400 });
      await retryBatchRefineRecording(changeId, ctx.userId, recordingVoice);
      wakeRecordingQueue();
      return NextResponse.json({ success: true });
    }

    if (action === 'approve-all') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      if (!runId) return NextResponse.json({ error: 'runId is required' }, { status: 400 });
      const selectedIds = Array.isArray(body.changeIds)
        ? new Set(body.changeIds.filter((value): value is string => typeof value === 'string'))
        : null;
      const pending = (await listPendingBatchRefineChanges(runId, ctx.userId))
        .filter((change: { id: string }) => !selectedIds || selectedIds.has(change.id));
      const approved: string[] = [];
      const failures: Array<{ changeId: string; error: string }> = [];
      for (const change of pending) {
        try {
          await approveBatchRefineChange({ changeId: change.id, userId: ctx.userId, recordingVoice });
          approved.push(change.id);
        } catch (error) {
          failures.push({
            changeId: change.id,
            error: error instanceof Error ? error.message : 'Approval failed.',
          });
        }
      }
      if (approved.length > 0) wakeRecordingQueue();
      return NextResponse.json({ success: failures.length === 0, approved, failures });
    }

    return NextResponse.json({ error: 'Unknown review action' }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Batch Refine review action failed.';
    return NextResponse.json(
      { error: message },
      { status: error instanceof BatchRefineReviewConflictError ? 409 : 500 },
    );
  }
}
