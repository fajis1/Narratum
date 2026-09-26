import { NextResponse, NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { eq, and, asc, lt, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookChapters, audiobookJobs, audiobooks, documents, documentSettings } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { serverLogger, errorToLog } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { runTaskNow } from '@/lib/server/tasks/engine';
import { wakeAudiobookQueue } from '@/lib/server/audiobooks/worker';
import {
  checkMonthlyAudiobookQuota,
  consumeAudiobookCredit,
  recordMonthlyAudiobookUsage,
} from '@/lib/server/access/audiobook-quota';
import { getPayPalReadiness } from '@/lib/server/paypal/config';
import {
  findSmartAudioProfileById,
  readSmartAudioProfilesDocument,
} from '@/lib/server/smart-audio-profiles';
import { readBookLexicon } from '@/lib/server/smart-audio/book-lexicon';
import { isKokoroCompatiblePronunciation } from '@/lib/shared/kokoro-pronunciation-policy';
import { queuedAudiobookBatchVersion } from '@/lib/shared/audiobook-batching';
import { AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS } from '@/lib/shared/audiobook-job-status';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import {
  getCharacterMapReadiness,
  MULTI_VOICE_WORKER_MODE,
  DRAMA_GEMINI_TTS_WORKER_MODE,
  requiresDramaAudiobookReplacement,
  WAITING_FOR_VOICES_STATUS,
} from '@/lib/shared/multi-voice';
import { isKokoroModel } from '@/lib/shared/kokoro';
import { getCloudTtsCharacterMapReadiness } from '@/lib/server/smart-audio/google-cloud-cast-helpers';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import { audiobookPrefix, deleteAudiobookPrefix } from '@/lib/server/audiobooks/blobstore';
import { readAudiobookRuntimeStatus } from '@/lib/shared/audiobook-runtime-phase';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';

export const dynamic = 'force-dynamic';

function parseJobSettings(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

export async function POST(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);

    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return new NextResponse('Unauthorized', { status: 401 });
    const userId = ctxOrRes.userId;

    const body = await req.json();
    const { documentId, settings } = body;
    const confirmScholarAutoScan = body.confirmScholarAutoScan === true;
    const confirmReplaceExisting = body.confirmReplaceExisting === true;
    const preflightOnly = body.preflightOnly === true;

    if (!documentId) {
      return NextResponse.json({ error: 'Missing documentId' }, { status: 400 });
    }

    const settingsRecord = settings && typeof settings === 'object'
      ? settings as Record<string, unknown>
      : {};
    const existingJobs = await db.select().from(audiobookJobs)
      .where(and(eq(audiobookJobs.userId, userId), eq(audiobookJobs.documentId, documentId)));
    
    // Only genuinely active jobs deduplicate. A fast completed job must not
    // block an immediate Resume request after a chapter is removed.
    const activeJob = existingJobs.find((j: typeof audiobookJobs.$inferSelect) =>
      j.status === 'queued' || 
      j.status === 'running' || 
      j.status === AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS ||
      j.status === 'waiting_for_pdf' || 
      j.status === WAITING_FOR_VOICES_STATUS ||
      j.status === 'paused'
    );

    if (activeJob) {
      // The worker may already be performing an acknowledged Scholar auto-scan.
      // Deduplicate before the lexicon gate so retries do not ask for the same
      // confirmation again or mutate the settings captured by the worker.
      return NextResponse.json({ jobId: activeJob.id });
    }

    let resolvedSmartAudioProfileId: string | null = null;
    let requestedWorkerMode: string | null = null;
    let profilesDocument: Awaited<ReturnType<typeof readSmartAudioProfilesDocument>> | null = null;
    if (settingsRecord.useSmartAudio === true) {
      const profiles = await readSmartAudioProfilesDocument(userId);
      profilesDocument = profiles;
      const profile = findSmartAudioProfileById(
        profiles,
        typeof settingsRecord.smartAudioProfileId === 'string'
          ? settingsRecord.smartAudioProfileId
          : profiles.selectedProfileId,
      );
      resolvedSmartAudioProfileId = profile?.id || null;
      requestedWorkerMode = profile?.workerMode || null;
      if (profile?.workerMode === 'scholar' || profile?.workerMode === 'bibliography-catcher') {
        const lexicon = await readBookLexicon(userId, documentId);
        const hasCompletedDefinitionScan = lexicon?.status === 'complete'
          && lexicon.definitionScanComplete === true
          && lexicon.profileId === profile.id
          && Object.values(lexicon.entries).every((entry) => (
            entry.pronunciation && isKokoroCompatiblePronunciation(entry.pronunciation)
          ));
        if (!hasCompletedDefinitionScan && !confirmScholarAutoScan) {
          return NextResponse.json({
            code: 'SCHOLAR_SCAN_REQUIRED',
            error: 'This book has not completed a pronunciation and definition scan.',
            message: 'Review the book pronunciations before generating. If you continue, OpenReader will scan unresolved foreign terms with the pronunciation model and adopt Gemini’s recommended defaults.',
          }, { status: 409 });
        }
      }
      if (profile?.workerMode === MULTI_VOICE_WORKER_MODE || profile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
        const isCloudDrama = profile.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE;
        if (!isCloudDrama && !isKokoroModel(typeof settingsRecord.ttsModel === 'string' ? settingsRecord.ttsModel : '')) {
          return NextResponse.json({
            code: 'MULTI_VOICE_KOKORO_REQUIRED',
            error: 'LitRPG Audio Drama currently requires a Kokoro TTS model.',
          }, { status: 409 });
        }
        const settingRows = await db.select({ dataJson: documentSettings.dataJson })
          .from(documentSettings)
          .where(and(
            eq(documentSettings.documentId, documentId),
            eq(documentSettings.userId, userId),
          ))
          .limit(1);
        const storedSettings = mergeDocumentSettings(
          DEFAULT_DOCUMENT_SETTINGS,
          parseJobSettings(settingRows[0]?.dataJson),
        );
        const readiness = isCloudDrama
          ? getCloudTtsCharacterMapReadiness(parseJobSettings(settingRows[0]?.dataJson).smartAudioCharacters)
          : getCharacterMapReadiness(storedSettings.smartAudioCharacters);
        if (!readiness.ready || readiness.map?.profileId !== profile.id) {
          return NextResponse.json({
            code: 'CHARACTER_CAST_REQUIRED',
            error: isCloudDrama
              ? 'Review and assign the Google Cloud Drama character voices before generation.'
              : 'Review and assign the LitRPG character voices before generation.',
            hasCharacterScan: Boolean(readiness.map),
            unassigned: readiness.unassigned,
          }, { status: 409 });
        }
      }
    }
    const existingChapter = await db.select({ id: audiobookChapters.id })
      .from(audiobookChapters)
      .where(and(
        eq(audiobookChapters.userId, userId),
        eq(audiobookChapters.bookId, documentId),
      ))
      .limit(1);
    const previousJob = [...existingJobs]
      .filter((candidate) => (
        candidate.status === 'completed'
        && parseJobSettings(candidate.settingsJson).batchRegenerate !== true
      ))
      .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))[0];
    const previousSettings = parseJobSettings(previousJob?.settingsJson);
    const previousProfileId = typeof previousSettings.smartAudioProfileId === 'string'
      ? previousSettings.smartAudioProfileId
      : '';
    const previousProfile = profilesDocument?.profiles.find(
      (candidate) => candidate.id === previousProfileId,
    ) || null;
    const requiresDramaReplacement = requiresDramaAudiobookReplacement({
      hasExistingChapters: existingChapter.length > 0,
      requestedWorkerMode,
      previousUseSmartAudio: previousSettings.useSmartAudio === true,
      previousWorkerMode: previousProfile?.workerMode,
    });
    if (requiresDramaReplacement && !confirmReplaceExisting) {
      return NextResponse.json({
        code: 'AUDIOBOOK_REPLACEMENT_REQUIRED',
        error: 'A regular audiobook already exists for this document.',
        message: 'Converting it to Audio Drama requires deleting and regenerating every existing chapter and combined audiobook file.',
      }, { status: 409 });
    }
    if (preflightOnly) {
      return NextResponse.json({
        ready: true,
        smartAudioProfileId: resolvedSmartAudioProfileId,
      });
    }
    const hasPriorFullGenerationJob = existingJobs.some((job: typeof audiobookJobs.$inferSelect) => (
      parseJobSettings(job.settingsJson).batchRegenerate !== true
    ));
    // Missing-chapter repairs and retries of an existing audiobook are included
    // with the original generation. A reset removes both chapters and queue
    // rows, so recording a new full generation after a reset uses a new slot.
    const shouldChargeMonthlyQuota = existingChapter.length === 0 && !hasPriorFullGenerationJob;
    const quota = shouldChargeMonthlyQuota
      ? await checkMonthlyAudiobookQuota({
          userId,
          isAdmin: Boolean((ctxOrRes.user as unknown as { isAdmin?: boolean | null })?.isAdmin),
        })
      : null;
    if (quota && !quota.allowed) {
      const paypal = getPayPalReadiness();
      return NextResponse.json({
        type: 'https://openreader.app/problems/monthly-audiobook-quota-exceeded',
        code: 'MONTHLY_AUDIOBOOK_QUOTA_EXCEEDED',
        error: 'Monthly audiobook limit reached.',
        limit: quota.limit,
        used: quota.used,
        freeLimit: quota.freeLimit,
        paidCreditsAvailable: quota.paidCreditsAvailable,
        resetTimeMs: quota.resetTimeMs,
        supportServerUrl: quota.supportServerUrl || null,
        supportMinimumUsd: quota.supportMinimumUsd,
        supportExtraAudiobooks: quota.supportExtraAudiobooks,
        paypalEnabled: paypal.enabled && !ctxOrRes.user?.isAnonymous,
      }, { status: 429 });
    }

    const resolvedSettingsRecord: Record<string, unknown> = {
      ...settingsRecord,
      ...(resolvedSmartAudioProfileId
        ? { smartAudioProfileId: resolvedSmartAudioProfileId }
        : {}),
    };

    const jobId = randomUUID();
    const testNamespace = req.headers.get('x-openreader-test-namespace');
    // Existing chapter indexes must keep the batching map that created them.
    // Jobs from before explicit versioning are therefore conservatively legacy.
    const cleanupBatchVersion = queuedAudiobookBatchVersion(
      existingChapter.length > 0,
      previousSettings.cleanupBatchVersion,
    );
    const settingsJson: Record<string, unknown> = {
      ...resolvedSettingsRecord,
      cleanupBatchVersion,
      monthlyQuotaCharge: shouldChargeMonthlyQuota,
      ...(confirmScholarAutoScan ? { scholarAutoScan: true } : {}),
    };
    if (testNamespace) {
      settingsJson.testNamespace = testNamespace;
    }

    if (requiresDramaReplacement) {
      await db.delete(audiobookChapters).where(and(
        eq(audiobookChapters.bookId, documentId),
        eq(audiobookChapters.userId, userId),
      ));
      await db.delete(audiobookJobs).where(and(
        eq(audiobookJobs.documentId, documentId),
        eq(audiobookJobs.userId, userId),
      ));
      await db.delete(audiobooks).where(and(
        eq(audiobooks.id, documentId),
        eq(audiobooks.userId, userId),
      ));
      const namespace = getOpenReaderTestNamespace(req.headers);
      await deleteAudiobookPrefix(audiobookPrefix(documentId, userId, namespace));
      serverLogger.info({
        event: 'audiobook.queue.drama_replacement.confirmed',
        documentId,
        userId,
      }, 'Deleted an existing regular audiobook before Audio Drama regeneration');
    }

    await db.insert(audiobookJobs).values({
      id: jobId,
      userId,
      documentId,
      status: 'queued',
      progress: 0,
      settingsJson,
    });
    if (quota?.shouldConsumeCredit) {
      await consumeAudiobookCredit({ userId, jobId });
    }
    if (shouldChargeMonthlyQuota) {
      await recordMonthlyAudiobookUsage({ userId, jobId });
    }

    runTaskNow('process-audiobook-queue').catch((err) => serverLogger.error({ event: 'audiobook.queue.wake.error', error: errorToLog(err) }, 'Failed to wake queue'));
    wakeAudiobookQueue();
    return NextResponse.json({ jobId });
  } catch (error) {
    serverLogger.error({ event: 'audiobook.queue.post.error', error: errorToLog(error) }, 'Failed to queue audiobook');
    return errorResponse(error, { apiErrorMessage: 'Failed to queue audiobook' });
  }
}

export async function GET(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return new NextResponse('Unauthorized', { status: 401 });
    const userId = ctxOrRes.userId;

    const url = new URL(req.url);
    const jobId = url.searchParams.get('jobId');

    if (jobId) {
      const jobRows = await db
        .select()
        .from(audiobookJobs)
        .where(and(eq(audiobookJobs.id, jobId), eq(audiobookJobs.userId, userId)));

      if (jobRows.length === 0) {
        return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      }

      const job = jobRows[0];
      const runtimeStatus = readAudiobookRuntimeStatus(job.settingsJson, job.status);
      let queuePosition = 0;

      if (job.status === 'queued') {
        const olderJobs = await db
          .select()
          .from(audiobookJobs)
          .where(and(eq(audiobookJobs.status, 'queued'), lt(audiobookJobs.createdAt, job.createdAt!)));
        queuePosition = olderJobs.length + 1;
      }

      return NextResponse.json({
        job: {
          ...job,
          phase: runtimeStatus.phase,
          gpuQueueState: runtimeStatus.gpuQueueState,
          runtimePhaseUpdatedAt: runtimeStatus.updatedAt,
        },
        queuePosition,
      });
    }

    // List all active jobs for the user
    const userJobsRaw = await db
      .select({
        job: audiobookJobs,
        documentTitle: documents.name,
      })
      .from(audiobookJobs)
      .leftJoin(documents, eq(audiobookJobs.documentId, documents.id))
      .where(eq(audiobookJobs.userId, userId))
      .orderBy(asc(audiobookJobs.createdAt));

    const userJobs = userJobsRaw.map((row: typeof userJobsRaw[0]) => {
      const runtimeStatus = readAudiobookRuntimeStatus(row.job.settingsJson, row.job.status);
      return {
        ...row.job,
        documentTitle: row.documentTitle,
        globalQueuePosition: 0,
        phase: runtimeStatus.phase,
        gpuQueueState: runtimeStatus.gpuQueueState,
        runtimePhaseUpdatedAt: runtimeStatus.updatedAt,
      };
    });

    const runningJobs = await db
      .select({ startedAt: audiobookJobs.startedAt, updatedAt: audiobookJobs.updatedAt, progress: audiobookJobs.progress })
      .from(audiobookJobs)
      .where(inArray(audiobookJobs.status, ['running', AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS]))
      .limit(1);

    for (const job of userJobs) {
      if (job.status === 'queued' || job.status === 'waiting_for_pdf') {
        const olderJobs = await db
          .select({ id: audiobookJobs.id })
          .from(audiobookJobs)
          .where(and(eq(audiobookJobs.status, 'queued'), lt(audiobookJobs.createdAt, job.createdAt!)));
        job.globalQueuePosition = olderJobs.length + 1;
      }
    }

    return NextResponse.json({ jobs: userJobs, activeGlobalJob: runningJobs.length > 0 ? runningJobs[0] : null });
  } catch (error) {
    serverLogger.error({ event: 'audiobook.queue.get.error', error: errorToLog(error) }, 'Failed to list audiobook jobs');
    return errorResponse(error, { apiErrorMessage: 'Failed to list audiobook jobs' });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return new NextResponse('Unauthorized', { status: 401 });
    
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const idsParam = url.searchParams.get('ids');
    const clear = url.searchParams.get('clear');

    if (!id && !idsParam && !clear) {
      return NextResponse.json({ error: 'Missing id, ids, or clear action' }, { status: 400 });
    }

    if (id) {
      await db.delete(audiobookJobs).where(and(eq(audiobookJobs.id, id), eq(audiobookJobs.userId, ctxOrRes.userId)));
      return NextResponse.json({ success: true });
    }

    if (idsParam) {
      const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) {
        await db.delete(audiobookJobs).where(and(inArray(audiobookJobs.id, ids), eq(audiobookJobs.userId, ctxOrRes.userId)));
      }
      return NextResponse.json({ success: true, count: ids.length });
    }

    if (clear === 'completed') {
      await db.delete(audiobookJobs)
        .where(and(eq(audiobookJobs.userId, ctxOrRes.userId), eq(audiobookJobs.status, 'completed')));
      return NextResponse.json({ success: true, cleared: 'completed' });
    }

    if (clear === 'error' || clear === 'failed') {
      await db.delete(audiobookJobs)
        .where(and(eq(audiobookJobs.userId, ctxOrRes.userId), eq(audiobookJobs.status, 'error')));
      return NextResponse.json({ success: true, cleared: 'failed' });
    }

    if (clear === 'finished' || clear === 'all_inactive' || clear === 'inactive') {
      await db.delete(audiobookJobs)
        .where(and(
          eq(audiobookJobs.userId, ctxOrRes.userId),
          inArray(audiobookJobs.status, ['completed', 'error'])
        ));
      return NextResponse.json({ success: true, cleared: 'finished' });
    }

    return NextResponse.json({ error: 'Invalid clear parameter' }, { status: 400 });
  } catch (error) {
    serverLogger.error({ event: 'audiobook.queue.delete.error', error: errorToLog(error) }, 'Failed to delete audiobook job');
    return errorResponse(error, { apiErrorMessage: 'Failed to delete audiobook job' });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return new NextResponse('Unauthorized', { status: 401 });
    
    const body = await req.json();
    const { id, requeueAllFailed } = body;
    if (!id && !requeueAllFailed) return NextResponse.json({ error: 'Missing id or requeueAllFailed' }, { status: 400 });

    if (requeueAllFailed === true) {
      await db.update(audiobookJobs)
        .set({ status: 'queued', error: null, progress: 0, startedAt: null, updatedAt: Date.now() })
        .where(and(eq(audiobookJobs.status, 'error'), eq(audiobookJobs.userId, ctxOrRes.userId)));
      runTaskNow('process-audiobook-queue').catch((err) => serverLogger.error({ event: 'audiobook.queue.wake.error', error: errorToLog(err) }, 'Failed to wake queue'));
      wakeAudiobookQueue();
      return NextResponse.json({ success: true });
    }

    await db.update(audiobookJobs)
      .set({ status: 'queued', error: null, progress: 0, startedAt: null, updatedAt: Date.now() })
      .where(and(eq(audiobookJobs.id, id), eq(audiobookJobs.userId, ctxOrRes.userId)));
      
    runTaskNow('process-audiobook-queue').catch((err) => serverLogger.error({ event: 'audiobook.queue.wake.error', error: errorToLog(err) }, 'Failed to wake queue'));
    wakeAudiobookQueue();
    return NextResponse.json({ success: true });
  } catch (error) {
    serverLogger.error({ event: 'audiobook.queue.put.error', error: errorToLog(error) }, 'Failed to requeue audiobook job');
    return errorResponse(error, { apiErrorMessage: 'Failed to requeue audiobook job' });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return new NextResponse('Unauthorized', { status: 401 });
    
    const body = await req.json();
    const { id, action } = body;
    if (!id || !action || !['pause', 'resume'].includes(action)) {
      return NextResponse.json({ error: 'Missing or invalid id/action' }, { status: 400 });
    }

    if (action === 'pause') {
      await db.update(audiobookJobs)
        .set({ status: 'paused', updatedAt: Date.now() })
        .where(and(eq(audiobookJobs.id, id), eq(audiobookJobs.userId, ctxOrRes.userId), inArray(audiobookJobs.status, ['queued', 'running', 'waiting_for_pdf'])));
    } else if (action === 'resume') {
      const existingRows = await db.select({ settingsJson: audiobookJobs.settingsJson })
        .from(audiobookJobs)
        .where(and(eq(audiobookJobs.id, id), eq(audiobookJobs.userId, ctxOrRes.userId)))
        .limit(1);

      let updatedSettingsJson: string | undefined = undefined;
      if (existingRows.length > 0) {
        try {
          const parsed = typeof existingRows[0].settingsJson === 'string'
            ? JSON.parse(existingRows[0].settingsJson)
            : (existingRows[0].settingsJson || {});
          if (parsed && typeof parsed === 'object') {
            delete parsed.nextAttemptAt;
            updatedSettingsJson = JSON.stringify(parsed);
          }
        } catch {}
      }

      await db.update(audiobookJobs)
        .set({
          status: 'queued',
          error: null,
          updatedAt: Date.now(),
          ...(updatedSettingsJson ? { settingsJson: updatedSettingsJson } : {}),
        })
        .where(and(
          eq(audiobookJobs.id, id),
          eq(audiobookJobs.userId, ctxOrRes.userId),
          inArray(audiobookJobs.status, ['paused', 'queued']),
        ));

      runTaskNow('process-audiobook-queue').catch((err) => serverLogger.error({ event: 'audiobook.queue.wake.error', error: errorToLog(err) }, 'Failed to wake queue'));
      wakeAudiobookQueue();
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    serverLogger.error({ event: 'audiobook.queue.patch.error', error: errorToLog(error) }, 'Failed to pause/resume audiobook job');
    return errorResponse(error, { apiErrorMessage: 'Failed to update audiobook job status' });
  }
}
