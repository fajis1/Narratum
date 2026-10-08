import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { pronunciationCatalog, pronunciationDictionary, readPronunciationChapter, resumeRepairedPronunciationJob, existingPronunciationRepair } from '@/lib/server/audiobooks/pronunciation-repairs';
import { loadPronunciationRepairConfig, pronunciationRepairErrorMessage } from '@/lib/server/audiobooks/pronunciation-repair-config';
import { listPronunciationRepairJobs, queuePronunciationRepairs, stopPronunciationRepairs, resumePronunciationRepairs } from '@/lib/server/audiobooks/pronunciation-repair-jobs';
import { serverLogger } from '@/lib/server/logger';
import { failedChapterReviewIssue, scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';
import { runTaskNow } from '@/lib/server/tasks/engine';
import { errorResponse } from '@/lib/server/errors/next-response';
import { pronunciationRepairReport } from '@/lib/server/audiobooks/pronunciation-repair-report';
import { listPronunciationRepairStatus, approvedPronunciationOverrideHash } from '@/lib/server/audiobooks/pronunciation-repair-status';
import { unacknowledgedPronunciationIssues } from '@/lib/shared/pronunciation-review-acknowledgment';
import type { PronunciationOverrideScanDiagnostic } from '@/lib/shared/pronunciation-review-acknowledgment';
import { batchRefineTextHash } from '@/lib/server/audiobooks/batch-refine-assessment';
import { rememberApprovedPronunciations } from '@/lib/server/audiobooks/remember-approved-pronunciations';
import { getAudiobookObjectBuffer } from '@/lib/server/audiobooks/blobstore';
import { coerceAudiobookGenerationSettings } from '@/lib/server/audiobooks/settings';
import { getDefaultVoices, isBuiltInTtsProviderId } from '@/lib/shared/tts-provider-catalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function ownedUser(request: Request, bookId: string): Promise<string | Response> {
  const ctx = await requireAuthContext(request);
  if (ctx instanceof Response) return ctx;
  if (!ctx.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, bookId), eq(documents.userId, ctx.userId))).limit(1);
  return rows.length ? ctx.userId : NextResponse.json({ error: 'Document not found' }, { status: 404 });
}

export async function GET(request: Request) {
  try {
    const bookId = new URL(request.url).searchParams.get('bookId') || '';
    const user = await ownedUser(request, bookId);
    if (user instanceof Response) return user;
    const action = new URL(request.url).searchParams.get('action');
    if (action === 'review-status') return NextResponse.json({ repairs: await listPronunciationRepairStatus(bookId, user) });
    if (action === 'report') {
      const report = await pronunciationRepairReport(bookId, user, new URL(request.url).searchParams.get('jobId') || '');
      if (!report) return NextResponse.json({ error: 'Repair job not found.' }, { status: 404 });
      return new Response(JSON.stringify(report, null, 2), { headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="pronunciation-repair-${report.jobId}.json"`,
      } });
    }
    if (action === 'config') {
      const publicConfig = (await loadPronunciationRepairConfig(user)).publicConfig;
      const parsed = JSON.parse((await getAudiobookObjectBuffer(bookId, user, 'audiobook.meta.json', null)).toString('utf8')) as unknown;
      const settings = coerceAudiobookGenerationSettings(parsed).settings;
      const recordingVoice = settings?.voice || '';
      const recordingVoices = settings && isBuiltInTtsProviderId(settings.providerType)
        ? Array.from(new Set([recordingVoice, ...getDefaultVoices(settings.providerType, settings.ttsModel)].filter(Boolean)))
        : recordingVoice ? [recordingVoice] : [];
      return NextResponse.json({ ...publicConfig, recordingVoice, recordingVoices });
    }
    if (action === 'jobs') return NextResponse.json({ jobs: await listPronunciationRepairJobs(bookId, user) });
    return NextResponse.json(await pronunciationCatalog(bookId, user));
  } catch (error) {
    return errorResponse(error, { apiErrorMessage: 'Could not list audiobook chapters.' });
  }
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const body = await request.json();
    if (typeof body.bookId !== 'string') return NextResponse.json({ error: 'Book is required.' }, { status: 400 });
    const user = await ownedUser(request, body.bookId);
    if (user instanceof Response) return user;
    const profileId = typeof body.profileId === 'string' ? body.profileId : undefined;
    if (body.action === 'remember-approved') return NextResponse.json(await rememberApprovedPronunciations(body.bookId, user));
    if (body.action === 'resume-repairs' && typeof body.jobId === 'string') {
      const result = await resumePronunciationRepairs(body.bookId, user, body.jobId, {
        profileId, aiModel: typeof body.aiModel === 'string' ? body.aiModel : undefined, fallbackModels: body.fallbackModels,
        primaryKeyRef: typeof body.primaryKeyRef === 'string' ? body.primaryKeyRef : undefined,
        backupKeyRef: typeof body.backupKeyRef === 'string' ? body.backupKeyRef : undefined,
      });
      void runTaskNow('process-audiobook-queue').catch(() => serverLogger.warn({ event: 'pronunciation.repair.wake_failed', requestId }, 'Repair queue will retry on the next scheduled tick'));
      return NextResponse.json(result, { status: 202 });
    }
    if (body.action === 'queue') {
      const result = await queuePronunciationRepairs({ bookId: body.bookId, userId: user, chapters: body.chapters, requestId: body.requestId, profileId,
        aiModel: typeof body.aiModel === 'string' ? body.aiModel : undefined,
        fallbackModels: body.fallbackModels,
        primaryKeyRef: typeof body.primaryKeyRef === 'string' ? body.primaryKeyRef : undefined,
        backupKeyRef: typeof body.backupKeyRef === 'string' ? body.backupKeyRef : undefined });
      void runTaskNow('process-audiobook-queue').catch(() => serverLogger.warn({ event: 'pronunciation.repair.wake_failed', requestId }, 'Repair queue will retry on the next scheduled tick'));
      return NextResponse.json(result, { status: 202 });
    }
    if (body.action === 'stop' && typeof body.jobId === 'string') {
      await stopPronunciationRepairs(body.bookId, user, body.jobId);
      return NextResponse.json({ success: true });
    }
    if (typeof body.fileName !== 'string') return NextResponse.json({ error: 'Chapter is required.' }, { status: 400 });
    if (body.action === 'scan') {
      const chapter = await readPronunciationChapter(body.bookId, user, body.fileName);
      const { dictionary } = await pronunciationDictionary(user, body.bookId, profileId || chapter.profileId);
      const existing = await existingPronunciationRepair(body.bookId, user, body.fileName, chapter.hash);
      const scanText = existing?.decision === 'pending' ? existing.proposedText : chapter.text;
      const allIssues = scanPronunciationIssues(scanText, dictionary);
      const overrideHash = await approvedPronunciationOverrideHash(body.bookId, user, body.fileName);
      const textHash = batchRefineTextHash(scanText);
      const scannedIssues = unacknowledgedPronunciationIssues(allIssues, textHash, overrideHash);
      const forcedFailureIssue = chapter.failed && !existing && !scannedIssues.length
        ? failedChapterReviewIssue(scanText, chapter.failureError)
        : null;
      const overrideDiagnostic: PronunciationOverrideScanDiagnostic = {
        version: 'pronunciation-override-rescan:v1', requestId,
        status: !overrideHash ? 'not_approved' : overrideHash === textHash ? 'matched' : 'text_changed',
        scannedText: existing?.decision === 'pending' ? 'pending_proposal' : 'saved_chapter',
        strictIssueCount: allIssues.length, acknowledgedIssueCount: allIssues.length - scannedIssues.length,
        actionableIssueCount: forcedFailureIssue ? 1 : scannedIssues.length,
      };
      serverLogger.info({ event: 'pronunciation.override.scan', bookId: body.bookId, chapterIndex: chapter.chapterIndex,
        fileName: body.fileName, ...overrideDiagnostic }, 'Pronunciation scan checked saved Override acknowledgment');
      return NextResponse.json({ fileName: body.fileName, chapterIndex: chapter.chapterIndex, title: chapter.title, failed: chapter.failed,
        hash: chapter.hash, jobId: chapter.jobId, failureError: chapter.failureError, runId: existing?.runId, audioStatus: existing?.audioStatus,
        retryRunId: existing?.decision === 'pending' ? existing.runId : undefined,
        proposalHash: existing?.decision === 'pending' ? existing.proposedTextHash : undefined,
        acknowledgedIssueCount: allIssues.length - scannedIssues.length,
        overrideDiagnostic,
        issues: forcedFailureIssue ? [forcedFailureIssue] : scannedIssues });
    }
    if (body.action === 'propose' && typeof body.hash === 'string') {
      return NextResponse.json({ error: 'Reload Reader to use background pronunciation repairs.' }, { status: 409 });
    }
    if (body.action === 'resume') {
      const jobId = await resumeRepairedPronunciationJob(body.bookId, user, body.fileName);
      void runTaskNow('process-audiobook-queue').catch(() => {});
      return NextResponse.json({ jobId });
    }
    return NextResponse.json({ error: 'Unknown scan action.' }, { status: 400 });
  } catch (error) {
    serverLogger.warn({ event: 'pronunciation.repair.request_failed', requestId, errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Pronunciation repair request failed');
    return NextResponse.json({ error: pronunciationRepairErrorMessage(error), requestId }, { status: 409 });
  }
}
