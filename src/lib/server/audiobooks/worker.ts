import { processBatchRefineJob } from './refine';
import { repairSmartAudioWorkerPronunciations, SmartAudioTargetedRepairError } from './smart-audio-targeted-repair';

import {
  findSmartAudioProfileById,
  mergeGeneratedPronunciationsIntoLatestProfile,
  readSmartAudioProfilesDocument,
  updateSmartAudioProfilePronunciations,
} from '@/lib/server/smart-audio-profiles';
import { eq, and, asc, lt, inArray, sql, or } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookJobs, documents, audiobooks, audiobookChapters, adminSettings, documentSettings } from '@/db/schema';
import { readCurrentParsedPdfArtifact } from '@/lib/server/pdf-parse/artifact';
import { getDocumentBlob } from '@/lib/server/documents/blobstore';
import { checkSystemResources } from '@/lib/server/audiobooks/system-monitor';
import { randomUUID } from 'node:crypto';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getAudiobookObjectBuffer, listAudiobookObjects, putAudiobookObject } from '@/lib/server/audiobooks/blobstore';
import { savePronunciationFailure } from '@/lib/server/audiobooks/pronunciation-failures';
import { encodeChapterFileName } from '@/lib/server/audiobooks/chapters';
import { createOrReuseCurrentPdfParseOperation } from '@/lib/server/pdf-parse/operation';
import { extractPdfToc, computeTocBoundaries } from '@/lib/server/pdf-parse/toc';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';
import type { TaskContext } from '@/lib/server/tasks/types';
import { serverLogger, errorToLog } from '@/lib/server/logger';
import { INTERNAL_WORKER_SECRET } from '@/lib/server/internal-secret';
import {
  buildKokoroPronunciationInstructions,
  filterKokoroCompatiblePronunciationRecord,
} from '@/lib/shared/kokoro-pronunciation-policy';
import {
  AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS,
  GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
  GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE,
  calculateRemainingDailyQuotaMs,
} from '@/lib/shared/audiobook-job-status';
import { isAudiobookJobEligibleToRun } from './queue-eligibility';
export { isAudiobookJobEligibleToRun } from './queue-eligibility';
import {
  resolveCleanupAiModel,
  resolveCleanupAiModels,
  resolveDramaDirectorModel,
  resolveSmartAudioValidationRepairModel,
} from '@/lib/shared/smart-audio-models';
import {
  AUDIOBOOK_END_MATTER_START_FRACTION,
  isAudiobookEndMatterHeading,
  truncateAudiobookEndMatter,
} from '@/lib/shared/audiobook-end-matter';
import {
  extractAudiobookTextFromEpub,
  stripAudiobookHtml,
} from '@/lib/server/audiobooks/document-source';
import {
  batchAudiobookText,
  cleanupBatchTargetForVersion,
  CURRENT_AUDIOBOOK_BATCH_VERSION,
} from '@/lib/shared/audiobook-batching';
import {
  collectSmartAudioTermCandidates,
  enrichTextFromBookLexicon,
  readBookLexicon,
  pronunciationsFromBookLexicon,
  resolveSmartAudioBookLexicon,
  selectPronunciationsForText,
  writeBookLexicon,
} from '@/lib/server/smart-audio/book-lexicon';
import { normalizeGeminiTokenUsage } from '@/lib/server/smart-audio/gemini-usage';
import { generateSegmentedAudiobookTtsBuffer } from '@/lib/server/audiobooks/segmented-tts';
import { CloudDramaGenerationError, generateCloudDramaAudiobook } from '@/lib/server/audiobooks/cloud-drama';
import { DramaDirectorValidationError } from '@/lib/server/smart-audio/drama-director';
import { persistCloudDramaReviewFlags } from '@/lib/server/audiobooks/cloud-drama-review';
import {
  autoAssignCloudTtsMinorVoices,
  getCloudTtsCharacterMapReadiness,
} from '@/lib/server/smart-audio/google-cloud-cast-helpers';
import {
  CLOUD_TTS_MODEL,
  CLOUD_TTS_FALLBACK_MODELS,
  CloudTtsQuotaExhaustedError,
  isCloudTtsQuotaExhaustedError,
} from '@/lib/server/smart-audio/google-cloud-tts-client';
import { resolveSmartAudioNatsTimeoutMs } from '@/lib/server/audiobooks/smart-audio-timeout';
import { mergeGlobalDefinitions, readGlobalDefinitions } from '@/lib/server/smart-audio/global-definition-library';
import { preparePdfAudiobookBlocks } from '@/lib/shared/pdf-audiobook-blocks';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS, type SmartAudioCharacterMap } from '@/types/document-settings';
import {
  buildSmartAudioCleanupPrompt,
  extractNarratableSmartAudioSourceText,
  FINAL_SMART_AUDIO_PRONUNCIATION_CHECK,
  hasConfirmedSmartAudioEndMatterHint,
  isScholarLikeSmartAudioMode,
  resolveSmartAudioWorkerResult,
  SmartAudioOutputValidationError,
  stripSmartAudioInputMarkers,
  validateSmartAudioOutput,
} from '@/lib/shared/smart-audio-cleanup';
import {
  autoAssignMinorCharacterVoices,
  buildMultiVoiceCast,
  getCharacterMapReadiness,
  MULTI_VOICE_WORKER_MODE,
  DRAMA_GEMINI_TTS_WORKER_MODE,
  parseVoiceTaggedText,
  renderVoiceSegments,
  resolveMultiVoiceWorkerResult,
  type MultiVoiceCastMember,
  type MultiVoiceSegment,
  WAITING_FOR_VOICES_STATUS,
} from '@/lib/shared/multi-voice';
import {
  buildSmartAudioValidationRepairPayload,
  resolveSmartAudioWithValidationRecovery,
} from '@/lib/server/audiobooks/smart-audio-validation-recovery';
import {
  writeAudiobookGpuRuntimeStatus,
  type GpuArbiterState,
} from '@/lib/shared/audiobook-runtime-phase';
import type {
  GpuArbiterStatus,
  GpuQueueRequestIdentity,
} from '@/lib/server/tts/gpu-arbiter';

const SMART_AUDIO_NATS_SUBJECT = 'audiobooks.gemini.clean';
// Scholar and bibliography-catcher both use the scholar Python worker,
// which produces changelogs, chapter titles, and inline definitions.
const SCHOLAR_NATS_SUBJECT = 'audiobooks.scholar.clean';

function isScholarLikeMode(mode: string | undefined): boolean {
  return isScholarLikeSmartAudioMode(mode);
}

async function readGlobalPronunciationDefaults(): Promise<Record<string, string>> {
  const rows = await db
    .select({ valueJson: adminSettings.valueJson })
    .from(adminSettings)
    .where(eq(adminSettings.key, 'global_pronunciations'))
    .limit(1);
  if (!rows[0]?.valueJson) return {};
  try {
    const parsed = typeof rows[0].valueJson === 'string'
      ? JSON.parse(rows[0].valueJson)
      : rows[0].valueJson;
    const defaults: Record<string, string> = {};
    for (const [term, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const first = Array.isArray(raw) ? raw[0] : raw;
      const pronunciation = typeof first === 'string'
        ? first
        : first && typeof first === 'object' && typeof (first as Record<string, unknown>).phonetic === 'string'
          ? String((first as Record<string, unknown>).phonetic)
          : '';
      if (pronunciation) defaults[term] = pronunciation;
    }
    return defaults;
  } catch {
    return {};
  }
}

const globalWorkerState = globalThis as unknown as { __worker_booted?: boolean };

class AudiobookJobStoppedError extends Error {
  constructor() {
    super('Audiobook job is no longer owned by this worker.');
    this.name = 'AudiobookJobStoppedError';
  }
}

async function acknowledgeAudiobookPause(jobId: string): Promise<boolean> {
  const rows = await db.update(audiobookJobs)
    .set({ status: 'paused', updatedAt: Date.now() })
    .where(and(
      eq(audiobookJobs.id, jobId),
      eq(audiobookJobs.status, AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS),
    ))
    .returning({ id: audiobookJobs.id });
  if (rows.length > 0) {
    serverLogger.info({ event: 'audiobook.queue.admin_paused', jobId }, 'Worker acknowledged an administrator pause request.');
  }
  return rows.length > 0;
}

async function updateAudiobookJobIfStatus(
  jobId: string,
  expectedStatus: string,
  values: Partial<typeof audiobookJobs.$inferInsert>,
): Promise<boolean> {
  const rows = await db.update(audiobookJobs)
    .set(values)
    .where(and(eq(audiobookJobs.id, jobId), eq(audiobookJobs.status, expectedStatus)))
    .returning({ id: audiobookJobs.id });
  if (rows.length > 0) return true;
  await acknowledgeAudiobookPause(jobId);
  return false;
}

async function updateClaimedAudiobookJob(
  jobId: string,
  expectedStatus: string,
  values: Partial<typeof audiobookJobs.$inferInsert>,
): Promise<void> {
  if (!await updateAudiobookJobIfStatus(jobId, expectedStatus, values)) {
    throw new AudiobookJobStoppedError();
  }
}

async function workerStillOwnsAudiobookJob(jobId: string): Promise<boolean> {
  const rows = await db.select({ status: audiobookJobs.status })
    .from(audiobookJobs)
    .where(eq(audiobookJobs.id, jobId))
    .limit(1);
  if (rows[0]?.status === 'running') return true;
  await acknowledgeAudiobookPause(jobId);
  return false;
}

async function publishAudiobookGpuStatus(
  jobId: string,
  status: GpuArbiterStatus | null,
): Promise<void> {
  const rows = await db.select({
    status: audiobookJobs.status,
    settingsJson: audiobookJobs.settingsJson,
  })
    .from(audiobookJobs)
    .where(eq(audiobookJobs.id, jobId))
    .limit(1);

  if (rows[0]?.status !== 'running') {
    await acknowledgeAudiobookPause(jobId);
    if (status) throw new AudiobookJobStoppedError();
    return;
  }

  const now = Date.now();
  const updated = await updateAudiobookJobIfStatus(jobId, 'running', {
    settingsJson: writeAudiobookGpuRuntimeStatus(
      rows[0].settingsJson,
      status?.state ?? null,
      now,
    ),
    updatedAt: now,
  });
  if (!updated && status) throw new AudiobookJobStoppedError();
}

async function generateQueuedAudiobookTts(
  jobId: string,
  request: Parameters<typeof generateSegmentedAudiobookTtsBuffer>[0],
  requestIdentity: GpuQueueRequestIdentity,
  runtimeSettings: Parameters<typeof generateSegmentedAudiobookTtsBuffer>[2],
): Promise<Buffer> {
  const controller = new AbortController();
  let cancellationCheckInFlight = false;
  const cancellationTimer = setInterval(() => {
    if (cancellationCheckInFlight || controller.signal.aborted) return;
    cancellationCheckInFlight = true;
    void workerStillOwnsAudiobookJob(jobId)
      .then((owned) => {
        if (!owned) controller.abort();
      })
      .catch((error) => {
        serverLogger.warn({
          event: 'audiobook.queue.cancel_check_failed',
          jobId,
          error: errorToLog(error),
        }, 'Could not check audiobook cancellation while TTS was active.');
      })
      .finally(() => { cancellationCheckInFlight = false; });
  }, 1_000);

  let lastLoggedState: GpuArbiterState | null = null;
  try {
    return await generateSegmentedAudiobookTtsBuffer(
      request,
      controller.signal,
      runtimeSettings,
      {
        requestIdentity,
        onStatus: async (status) => {
          try {
            await publishAudiobookGpuStatus(jobId, status);
          } catch (error) {
            if (error instanceof AudiobookJobStoppedError) throw error;
            serverLogger.warn({
              event: 'audiobook.queue.gpu_status_publish_failed',
              jobId,
              error: errorToLog(error),
            }, 'GPU queue status could not be published; TTS will continue.');
            return;
          }
          const nextState = status?.state ?? null;
          if (nextState !== lastLoggedState) {
            serverLogger.info({
              event: 'audiobook.queue.gpu_status',
              jobId,
              state: nextState || 'unavailable',
            }, 'Audiobook GPU queue status changed.');
            lastLoggedState = nextState;
          }
        },
      },
    );
  } catch (error) {
    if (controller.signal.aborted && !await workerStillOwnsAudiobookJob(jobId)) {
      throw new AudiobookJobStoppedError();
    }
    throw error;
  } finally {
    clearInterval(cancellationTimer);
    await publishAudiobookGpuStatus(jobId, null).catch(() => {});
  }
}

export async function getDocumentCharacterUsageMetrics(
  bookId: string,
  userId: string,
  namespace: string | null = null,
  characterMap?: SmartAudioCharacterMap | null,
): Promise<Record<string, { spokenLength: number; chapterCount: number }>> {
  const metrics: Record<string, { spokenLength: number; chapterCount: number }> = {};
  try {
    const objects = await listAudiobookObjects(bookId, userId, namespace);
    const textFiles = objects
      .map((o) => o.fileName)
      .filter((name) => /^\d{4}__text\.txt$/i.test(name));

    const voiceToCharacterName = new Map<string, string>();
    if (characterMap?.entries) {
      for (const entry of Object.values(characterMap.entries)) {
        if (!entry.aliasFor && entry.voiceId) {
          voiceToCharacterName.set(entry.voiceId, entry.name);
        }
      }
    }

    const voiceUsage: Record<string, { spokenLength: number; chapters: Set<string> }> = {};

    for (const fileName of textFiles) {
      try {
        const buf = await getAudiobookObjectBuffer(bookId, userId, fileName, namespace);
        const text = buf.toString('utf8');
        if (!/<\/?voice\b/iu.test(text)) continue;

        const segments = parseVoiceTaggedText(text, { includeOmitted: true });
        const voicesInThisChapter = new Set<string>();

        for (const seg of segments) {
          if (!seg.voiceId) continue;
          if (!voiceUsage[seg.voiceId]) {
            voiceUsage[seg.voiceId] = { spokenLength: 0, chapters: new Set() };
          }
          if (!seg.omitted) {
            voiceUsage[seg.voiceId].spokenLength += (seg.text || '').length;
          }
          voicesInThisChapter.add(seg.voiceId);
        }

        for (const v of voicesInThisChapter) {
          voiceUsage[v].chapters.add(fileName);
        }
      } catch (err) {
        serverLogger.warn({
          event: 'audiobook.queue.metrics.chapter_parse_error',
          bookId,
          fileName,
          error: err instanceof Error ? err.message : String(err),
        }, 'Failed to parse chapter text for character metrics');
      }
    }

    for (const [voiceId, data] of Object.entries(voiceUsage)) {
      const charName = voiceToCharacterName.get(voiceId);
      const usage = {
        spokenLength: data.spokenLength,
        chapterCount: data.chapters.size,
      };
      if (charName) {
        metrics[charName] = usage;
      } else {
        metrics[voiceId] = usage;
      }
    }
  } catch (error) {
    serverLogger.warn({
      event: 'audiobook.queue.metrics.error',
      bookId,
      error: error instanceof Error ? error.message : String(error),
    }, 'Failed to collect character usage metrics');
  }

  return metrics;
}

export async function resumeWaitingAudioDramaJobs(): Promise<number> {
  let resumedCount = 0;
  try {
    const waitingJobs = await db.select()
      .from(audiobookJobs)
      .where(eq(audiobookJobs.status, WAITING_FOR_VOICES_STATUS))
      .limit(50);

    for (const job of waitingJobs) {
      try {
        const [docRow] = await db.select({ dataJson: documentSettings.dataJson })
          .from(documentSettings)
          .where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, job.userId)))
          .limit(1);

        if (!docRow?.dataJson) continue;
        const currentSettings = typeof docRow.dataJson === 'string'
          ? JSON.parse(docRow.dataJson)
          : docRow.dataJson;

        const charMap = currentSettings.smartAudioCharacters;
        if (!charMap || typeof charMap !== 'object') continue;

        const jobSettings = typeof job.settingsJson === 'string'
          ? JSON.parse(job.settingsJson)
          : (job.settingsJson || {});
        const testNamespace = typeof jobSettings.testNamespace === 'string'
          ? jobSettings.testNamespace
          : null;

        const profiles = await readSmartAudioProfilesDocument(job.userId);
        const profile = findSmartAudioProfileById(profiles, jobSettings.smartAudioProfileId || profiles.selectedProfileId);
        const isCloudDrama = profile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE;

        const readiness = isCloudDrama
          ? getCloudTtsCharacterMapReadiness(charMap)
          : getCharacterMapReadiness(charMap);
        if (readiness.unassigned.length > 0 && readiness.map) {
          const metrics = isCloudDrama ? {} : await getDocumentCharacterUsageMetrics(
            job.bookId,
            job.userId,
            testNamespace,
            readiness.map,
          );
          const autoResult = isCloudDrama
            ? autoAssignCloudTtsMinorVoices({ characterMap: readiness.map })
            : autoAssignMinorCharacterVoices({
                characterMap: readiness.map,
                characterUsageMetrics: metrics,
              });

          if (autoResult.assigned.length > 0) {
            currentSettings.smartAudioCharacters = autoResult.updatedMap;
            await db.update(documentSettings)
              .set({ dataJson: JSON.stringify(currentSettings) })
              .where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, job.userId)));

            serverLogger.info({
              event: 'audiobook.queue.multivoice.startup_auto_assigned',
              jobId: job.id,
              bookId: job.bookId,
              assigned: autoResult.assigned,
            }, 'Startup hook: auto-assigned recyclable voices to waiting characters.');
          }

          const newReadiness = isCloudDrama
            ? getCloudTtsCharacterMapReadiness(autoResult.updatedMap)
            : getCharacterMapReadiness(autoResult.updatedMap);
          if (newReadiness.ready) {
            await db.update(audiobookJobs)
              .set({ status: 'queued', error: null, progress: 0, updatedAt: Date.now() })
              .where(eq(audiobookJobs.id, job.id));
            resumedCount += 1;
            serverLogger.info({
              event: 'audiobook.queue.multivoice.requeued_waiting_job',
              jobId: job.id,
              bookId: job.bookId,
            }, 'Startup hook: requeued waiting_for_voices job after auto-assigning voices.');
          }
        } else if (readiness.ready) {
          await db.update(audiobookJobs)
            .set({ status: 'queued', error: null, progress: 0, updatedAt: Date.now() })
            .where(eq(audiobookJobs.id, job.id));
          resumedCount += 1;
          serverLogger.info({
            event: 'audiobook.queue.multivoice.requeued_ready_job',
            jobId: job.id,
            bookId: job.bookId,
          }, 'Startup hook: requeued previously ready waiting_for_voices job.');
        }
      } catch (jobErr) {
        serverLogger.warn({
          event: 'audiobook.queue.multivoice.resume_error',
          jobId: job.id,
          error: jobErr instanceof Error ? jobErr.message : String(jobErr),
        }, 'Failed to resume waiting audiobook job.');
      }
    }
  } catch (err) {
    serverLogger.warn({
      event: 'audiobook.queue.multivoice.resume_all_error',
      error: err instanceof Error ? err.message : String(err),
    }, 'Failed during resumeWaitingAudioDramaJobs pass.');
  }
  return resumedCount;
}

const MAX_CONCURRENT_JOBS = 3;
const activeRunningJobs = new Map<string, Promise<void>>();
let isQueueLoopRunning = false;
let wakeQueueResolve: (() => void) | null = null;

export function wakeAudiobookQueue() {
  if (wakeQueueResolve) {
    wakeQueueResolve();
    wakeQueueResolve = null;
  }
}

export async function processAudiobookQueue(context?: TaskContext) {
  if (!globalWorkerState.__worker_booted) {
    globalWorkerState.__worker_booted = true;
    serverLogger.info({ event: 'audiobook.queue.boot' }, 'Worker booted. Resetting any orphaned running jobs to queued.');
    await db.update(audiobookJobs)
      .set({ status: 'paused', updatedAt: Date.now() })
      .where(eq(audiobookJobs.status, AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS));
    await db.update(audiobookJobs)
      .set({ status: 'queued', progress: 0 })
      .where(eq(audiobookJobs.status, 'running'));
    await resumeWaitingAudioDramaJobs();
  } else {
    // Reset any jobs that have been "running" for over 15 minutes without an update (stale crash recovery)
    // Only reset jobs that are not actively running in this process
    const staleThreshold = Date.now() - 15 * 60 * 1000;
    const runningInDb = await db.select({ id: audiobookJobs.id }).from(audiobookJobs)
      .where(and(eq(audiobookJobs.status, 'running'), lt(audiobookJobs.updatedAt, staleThreshold)));
    const trulyStale = runningInDb.filter((r: { id: string }) => !activeRunningJobs.has(r.id)).map((r: { id: string }) => r.id);
    if (trulyStale.length > 0) {
      await db.update(audiobookJobs)
        .set({ status: 'queued', progress: 0 })
        .where(inArray(audiobookJobs.id, trulyStale));
    }
  }

  const resources = await checkSystemResources();
  if (!resources.ok) {
    serverLogger.warn({ event: 'audiobook.queue.degraded', reason: resources.reason }, `System resources degraded: ${resources.reason}`);
    return;
  }

  if (isQueueLoopRunning) {
    wakeAudiobookQueue();
    return;
  }

  isQueueLoopRunning = true;
  const RATE_LIMIT_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24 hours
  const backoffThreshold = Date.now() - RATE_LIMIT_BACKOFF_MS;

  try {
    while (!context?.signal?.aborted && (!context?.deadlineAt || Date.now() < context.deadlineAt)) {
      const availableSlots = Math.max(0, MAX_CONCURRENT_JOBS - activeRunningJobs.size);
      if (availableSlots > 0) {
        const queuedRows = await db.select()
          .from(audiobookJobs)
          .where(
            inArray(audiobookJobs.status, ['queued', 'waiting_for_pdf']),
          )
          .orderBy(asc(audiobookJobs.createdAt))
          .limit(100);

        const now = Date.now();
        const eligibleRows = queuedRows.filter((row: typeof queuedRows[0]) =>
          isAudiobookJobEligibleToRun(row, activeRunningJobs, now, backoffThreshold)
        );

        const toClaim = eligibleRows.slice(0, availableSlots);
        if (toClaim.length > 0) {
          const jobIds = toClaim.map((r: { id: string }) => r.id);
          const updateResult = await db.update(audiobookJobs)
            .set({ status: 'running', startedAt: Date.now(), error: null })
            .where(and(inArray(audiobookJobs.id, jobIds), inArray(audiobookJobs.status, ['queued', 'waiting_for_pdf'])))
            .returning();

          for (const job of updateResult) {
            const jobPromise = (async () => {
              try {
                await processSingleAudiobookJob(job);
              } catch (err) {
                serverLogger.error({ event: 'audiobook.queue.job_unhandled_error', jobId: job.id, error: errorToLog(err) }, 'Unhandled error in processSingleAudiobookJob');
              } finally {
                activeRunningJobs.delete(job.id);
                wakeAudiobookQueue();
              }
            })();
            activeRunningJobs.set(job.id, jobPromise);
          }
        }
      }

      if (activeRunningJobs.size === 0) {
        break;
      }

      const wakePromise = new Promise<void>((resolve) => {
        wakeQueueResolve = resolve;
      });

      await Promise.race([
        Promise.race(Array.from(activeRunningJobs.values())),
        new Promise((resolve) => setTimeout(resolve, 5000)),
        wakePromise,
      ]);
    }
  } finally {
    isQueueLoopRunning = false;
  }
}

async function processSingleAudiobookJob(job: typeof audiobookJobs.$inferSelect) {
  const updateProgress = async (progress: number) => {
    await updateClaimedAudiobookJob(job.id, 'running', { progress, updatedAt: Date.now() });
  };

  const markError = async (err: string) => {
    await updateAudiobookJobIfStatus(job.id, 'running', {
      status: 'error',
      error: err,
      completedAt: Date.now(),
    });
  };

  try {
    serverLogger.info({ event: 'audiobook.queue.start', jobId: job.id, documentId: job.documentId }, `Starting background audiobook generation job ${job.id}`);
    if (!await workerStillOwnsAudiobookJob(job.id)) return;
    await publishAudiobookGpuStatus(job.id, null).catch((error) => {
      serverLogger.warn({
        event: 'audiobook.queue.gpu_status_cleanup_failed',
        jobId: job.id,
        error: errorToLog(error),
      }, 'A stale GPU queue phase could not be cleared; audiobook generation will continue.');
    });
    const docRows = await db.select().from(documents).where(eq(documents.id, job.documentId));
    if (docRows.length === 0) throw new Error('Document not found');
    const doc = docRows[0];

    const bookId = doc.id;
    const userId = job.userId;
    const jobSettings = typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : (job.settingsJson || {});

    if (jobSettings.jobType === 'pronunciation-repair') {
      const { processPronunciationRepairJob } = await import('./pronunciation-repair-jobs');
      await processPronunciationRepairJob(job);
      return;
    }

    if (jobSettings.jobType === 'batch-refine') {
      await processBatchRefineJob(job, updateProgress, markError);
      await updateClaimedAudiobookJob(job.id, 'running', { status: 'completed', progress: 100, completedAt: Date.now() });
      return;
    }

    if (jobSettings.jobType === 'combine') {
      const { executeAudiobookCombine } = await import('./combine');
      try {
        serverLogger.info({ event: 'audiobook.combine.debug' }, 'Calling executeAudiobookCombine...');
        await executeAudiobookCombine(bookId, userId, jobSettings.format, jobSettings.testNamespace, updateProgress);
        serverLogger.info({ event: 'audiobook.combine.debug' }, 'Updating combine job status to completed...');
        await updateClaimedAudiobookJob(job.id, 'running', { status: 'completed', progress: 100, completedAt: Date.now() });
        serverLogger.info({ event: 'audiobook.queue.complete', jobId: job.id, documentId: job.documentId }, `Successfully completed audiobook combine job ${job.id}`);
      } catch (combineError) {
        serverLogger.error({ event: 'audiobook.combine.failed', jobId: job.id, error: errorToLog(combineError) }, 'Audiobook background combine failed');
        await markError((combineError as Error)?.message || 'Combine failed');
      }
      return;
    }

    const existingBook = await db.select().from(audiobooks).where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, userId)));
    // Missing/legacy versions must retain the exact pre-12K chapter map so a
    // resumed job never reuses an existing numeric index for different text.
    const usesCurrentBatching = jobSettings.cleanupBatchVersion === CURRENT_AUDIOBOOK_BATCH_VERSION;
    const cleanupTargetCharacters = cleanupBatchTargetForVersion(jobSettings.cleanupBatchVersion);
    const hasSmartAudio = !!jobSettings?.useSmartAudio;
    const testNamespace = jobSettings?.testNamespace || null;

    if (existingBook.length === 0) {
      await db.insert(audiobooks).values({
        id: bookId,
        userId: userId,
        title: doc.name,
        hasSmartAudio,
      });
    } else if (hasSmartAudio && !existingBook[0].hasSmartAudio) {
      // Upgrade existing audiobook to show it has smart audio changelog
      await db.update(audiobooks).set({ hasSmartAudio: true }).where(eq(audiobooks.id, bookId));
    }

    // Foreground regeneration reads this metadata to reproduce the exact
    // chapter boundaries used by background queue generation.
    await putAudiobookObject(
      bookId,
      userId,
      'audiobook.meta.json',
      Buffer.from(JSON.stringify(jobSettings, null, 2), 'utf8'),
      'application/json; charset=utf-8',
      testNamespace,
    );

    let chapters: { index: number; title: string; text: string; cleanupText?: string }[] = [];
    let tocSectionsSkipped = 0;

    const documentSettingsRows = await db
      .select({ dataJson: documentSettings.dataJson })
      .from(documentSettings)
      .where(and(eq(documentSettings.documentId, doc.id), eq(documentSettings.userId, userId)))
      .limit(1);
    let rawDocumentSettings: unknown = documentSettingsRows[0]?.dataJson || {};
    if (typeof rawDocumentSettings === 'string') {
      try {
        rawDocumentSettings = JSON.parse(rawDocumentSettings);
      } catch {
        rawDocumentSettings = {};
      }
    }
    const resolvedDocumentSettings = mergeDocumentSettings(
      DEFAULT_DOCUMENT_SETTINGS,
      rawDocumentSettings,
    );

    const useSmartAudio = Boolean(jobSettings.useSmartAudio);
    const profilesDocument = useSmartAudio
      ? await readSmartAudioProfilesDocument(userId)
      : null;
    let selectedProfile = profilesDocument
      ? findSmartAudioProfileById(profilesDocument, String(jobSettings.smartAudioProfileId || ''))
      : null;
    if (useSmartAudio && !selectedProfile) {
      throw new Error('The selected Smart Audio profile could not be loaded.');
    }
    // Scholar and bibliography-catcher both get layout engine structural tags so
    // Gemini can understand PDF structure. Previously only bib-catcher had this.
    const useLayoutTags = isScholarLikeMode(selectedProfile?.workerMode);


    if (doc.type === 'pdf') {
      let artifact = await readCurrentParsedPdfArtifact({ documentId: doc.id, namespace: testNamespace });
      if (!artifact) {
        const opState = await createOrReuseCurrentPdfParseOperation({ documentId: doc.id, namespace: testNamespace });
        if (opState.status === 'failed') {
          throw new Error(opState.error?.message || 'PDF layout operation failed');
        }
        await updateClaimedAudiobookJob(job.id, 'running', { status: 'waiting_for_pdf' });
        
        // Wait up to 15 seconds for the PDF artifact (e.g. for compute-core to finish parsing it in the background)
        let found = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          artifact = await readCurrentParsedPdfArtifact({ documentId: doc.id, namespace: testNamespace });
          if (artifact) {
            found = true;
            await updateClaimedAudiobookJob(job.id, 'waiting_for_pdf', { status: 'running' });
            break;
          }
        }
        
        if (!found) {
          return;
        }
      }
      if (!artifact) {
        return;
      }
      const parsedPdf = JSON.parse(artifact.bytes.toString('utf-8')) as ParsedPdfDocument;
      
      const buffer = await getDocumentBlob(doc.id, testNamespace);
      const toc = await extractPdfToc(buffer);
      let boundaries = computeTocBoundaries(toc, doc.pages || 9999);
      
      // FALLBACK MULTIVALENT SYSTEM: If digital TOC is missing, scan the vision-engine text!
      if (toc.length === 0 && parsedPdf && parsedPdf.pages) {
        console.log('\n[FALLBACK SCANNER] Digital TOC missing. Scanning vision engine text for boundaries...');
        
        // --- 1. Find Start Matter (scan first 30% forwards) ---
        const startLimit = Math.floor(parsedPdf.pages.length * 0.3);
        const frontMatterRegex = /^(introduction|chapter 1\b|part 1\b|foreword|preface|prologue)/i;
        for (let i = 0; i <= startLimit; i++) {
          const page = parsedPdf.pages[i];
          const hasStartMatterTitle = page.blocks.some(b => 
            (b.kind === 'paragraph_title' || b.kind === 'doc_title') && 
            b.text.trim().length < 50 &&
            frontMatterRegex.test(b.text.trim())
          );
          if (hasStartMatterTitle) {
            boundaries.startPage = page.pageNumber;
            console.log(`[FALLBACK SCANNER] Found Start Matter (Introduction/Chapter 1)! Setting start page to ${boundaries.startPage}`);
            break;
          }
        }

        // --- 2. Find End Matter (scan last 30% backwards) ---
        let fallbackEndPage = boundaries.endPage;
        const endMatterRegex = /^(bibliography|index|indexes|works cited|notes|appendix)/i;
        const endLimit = Math.floor(
          parsedPdf.pages.length * AUDIOBOOK_END_MATTER_START_FRACTION,
        );
        for (let i = parsedPdf.pages.length - 1; i >= endLimit; i--) {
          const page = parsedPdf.pages[i];
          const hasEndMatterTitle = page.blocks.some(b => 
            (b.kind === 'paragraph_title' || b.kind === 'doc_title') && 
            b.text.trim().length < 50 &&
            endMatterRegex.test(b.text.trim())
          );
          if (hasEndMatterTitle) {
            fallbackEndPage = page.pageNumber - 1;
          }
        }
        if (fallbackEndPage < boundaries.endPage) {
          boundaries.endPage = fallbackEndPage;
          console.log(`[FALLBACK SCANNER] Found End Matter! Setting end page to ${boundaries.endPage}`);
        }
      }

      serverLogger.info({ event: 'audiobook.toc.boundaries', startPage: boundaries.startPage, endPage: boundaries.endPage }, 'Computed TOC boundaries for PDF');
      console.log(`\n==========================================\n  TOC BOUNDARY CALCULATED\n  Start Page (Gemini hint before this): ${boundaries.startPage}\n  End Page (Gemini hint after this): ${boundaries.endPage}\n==========================================\n`);

      const preparedPdfBlocks = preparePdfAudiobookBlocks({
        parsed: parsedPdf,
        settings: resolvedDocumentSettings,
        cleanupBatchVersion: jobSettings.cleanupBatchVersion,
      });
      const allBlocks = preparedPdfBlocks.blocks;
      if (preparedPdfBlocks.skippedBlockCount > 0) {
        serverLogger.info({
          event: 'audiobook.queue.pdf_blocks.skipped',
          bookId,
          count: preparedPdfBlocks.skippedBlockCount,
          kinds: resolvedDocumentSettings.pdf?.skipBlockKinds || [],
        }, 'Removed configured PDF block kinds before chapter batching.');
      }
      if (preparedPdfBlocks.tocSkipped) {
        tocSectionsSkipped += 1;
        serverLogger.info({
          event: 'audiobook.queue.front_matter.skipped',
          bookId,
          section: 'table_of_contents',
        }, 'Removed the PDF table of contents before Smart Audio and TTS processing.');
      }
      if (preparedPdfBlocks.endMatterSkipped) {
        serverLogger.info({
          event: 'audiobook.queue.end_matter.omitted',
          bookId,
          reason: 'confirmed_pdf_end_matter',
          heading: preparedPdfBlocks.endMatterStartHeading,
          startPage: preparedPdfBlocks.endMatterStartPage,
          count: preparedPdfBlocks.endMatterSkippedBlockCount,
        }, 'Removed PP-DocLayout-confirmed PDF end matter before chapter batching.');
      }
      const chapterBoundaryKinds = new Set(['paragraph_title', 'doc_title']);
      
      let currentTitle = 'Introduction';
      let currentText: string[] = [];
      let currentLength = 0;
      let lastBlockWasTitle = false;
      
      let isInEndMatter = false;
      
      const flush = () => {
        let text = currentText.join('\n\n').trim();
        if (text) {
          if (isInEndMatter) {
             text = `[SYSTEM HINT: The layout engine detected that this section is located in the end-matter (e.g. bibliography, index, or notes) of the book. If this text is not part of the core narrative prose, please silently omit it.]\n\n` + text;
          }
          chapters.push({ index: chapters.length, title: currentTitle, text });
        }
        currentText = [];
        currentLength = 0;
        lastBlockWasTitle = false;
      };

      for (let blockIndex = 0; blockIndex < allBlocks.length; blockIndex += 1) {
        const block = allBlocks[blockIndex];
        const blockText = block.text.trim();
        if (!blockText) continue;

        if (block.pageNumber < boundaries.startPage) {
           continue;
        }
        
        if (chapterBoundaryKinds.has(block.kind)) {
          const blockProgress = blockIndex / Math.max(allBlocks.length, 1);
          const startsConfirmedEndMatter = blockProgress >= AUDIOBOOK_END_MATTER_START_FRACTION
            && (
              (usesCurrentBatching && isAudiobookEndMatterHeading(blockText))
              || block.pageNumber > boundaries.endPage
            );
          if (startsConfirmedEndMatter && !isInEndMatter) {
            // Finish the preceding narrative chunk before enabling the end-
            // matter hint. Otherwise a bibliography heading could cause the
            // prior chapter's prose to be included in the omission request.
            if (currentText.length > 0) flush();
            isInEndMatter = true;
          }
          
          if (currentLength >= cleanupTargetCharacters) {
            flush();
            currentTitle = blockText || `Chapter ${chapters.length + 1}`;
          } else if (currentText.length === 0) {
            currentTitle = blockText || `Chapter ${chapters.length + 1}`;
          }
          currentText.push(useLayoutTags ? `\n\n[LAYOUT_ENGINE_TAG: ${block.kind.toUpperCase()}]\n${blockText}` : blockText);
          currentLength += blockText.length + 2;
          lastBlockWasTitle = true;
        } else {
          const lastIndex = currentText.length - 1;
          const isContinuation = !lastBlockWasTitle && lastIndex >= 0 && !/[.!?…'"”’\]}):;]\s*$/.test(currentText[lastIndex]);

          // Only flush if we are safely AT a paragraph boundary!
          if (!isContinuation && currentLength >= cleanupTargetCharacters) {
            flush();
            currentTitle = currentTitle.endsWith('(Continued)') ? currentTitle : `${currentTitle} (Continued)`;
          }

          if (isContinuation && lastIndex >= 0) {
            currentText[lastIndex] += ' ' + blockText;
            currentLength += blockText.length + 1;
          } else {
            currentText.push(useLayoutTags ? `\n\n[LAYOUT_ENGINE_TAG: ${block.kind.toUpperCase()}]\n${blockText}` : blockText);
            currentLength += blockText.length + 2;
          }
          lastBlockWasTitle = false;
        }
      }
      flush();

    } else if (doc.type === 'epub') {
      const buffer = await getDocumentBlob(doc.id, testNamespace);
      const epubChapters = await extractAudiobookTextFromEpub(buffer);
      chapters = epubChapters.map((c, i) => ({ index: i, title: c.title, text: c.text }));
    } else if (doc.type === 'txt' || doc.type === 'html') {
      const buffer = await getDocumentBlob(doc.id, testNamespace);
      let text = buffer.toString('utf-8');
      if (doc.type === 'html') text = stripAudiobookHtml(text);
      chapters = [{ index: 0, title: 'Document', text }];
    } else {
      throw new Error(`Unsupported document type: ${doc.type}`);
    }

    const runtimeConfig = await getResolvedRuntimeConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settings = jobSettings as Record<string, any>;
    if (usesCurrentBatching) {
      chapters = batchAudiobookText(
        truncateAudiobookEndMatter(chapters),
        cleanupTargetCharacters,
      );
    }
    if (useLayoutTags) {
      chapters = chapters
        .map((chapter) => ({
          ...chapter,
          cleanupText: chapter.text,
          text: stripSmartAudioInputMarkers(chapter.text),
        }))
        .filter((chapter) => Boolean(chapter.text));
    }
    if (chapters.length === 0) throw new Error('No audiobook content found before end matter');
    const format = (settings.format as 'mp3' | 'm4b') || 'm4b';

    const creds = selectedProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE ? null : await resolveTtsCredentials({
      providerHeader: settings.providerRef || null,
      apiKeyHeader: null,
      baseUrlHeader: null,
      fallbackProvider: runtimeConfig.defaultTtsProvider,
      restrictUserApiKeys: true,
    });

    if (creds && 'error' in creds) {
      throw new Error(`Failed to resolve TTS credentials: ${creds.error}. Background generation requires admin TTS providers.`);
    }

    let processedLength = 0;
    let totalBytes = 0;
    const totalLength = chapters.reduce((sum, c) => sum + c.text.length, 0);
    const pronunciationsAtAutoScanStart = {
      ...(selectedProfile?.pronunciations || {}),
    };
    // The global library is always the baseline. Profile pronunciations are
    // applied afterward and therefore act as per-word local overrides.
    const globalPronunciations = await readGlobalPronunciationDefaults();
    const globalDefinitions = isScholarLikeMode(selectedProfile?.workerMode)
      ? await readGlobalDefinitions()
      : {};
    let resolvedPronunciations = filterKokoroCompatiblePronunciationRecord({
      ...globalPronunciations,
      ...(selectedProfile?.pronunciations || {}),
    });
    let bookLexicon = isScholarLikeMode(selectedProfile?.workerMode)
      ? await readBookLexicon(userId, doc.id)
      : null;
    const definitionsBeforeAutoScan = new Map(
      Object.entries(bookLexicon && bookLexicon.profileId === selectedProfile?.id ? bookLexicon.entries : {})
        .map(([term, entry]) => [term, entry.definition]),
    );
    let definitionPassRan = false;

    if (
      selectedProfile &&
      isScholarLikeMode(selectedProfile.workerMode)
      && (
        bookLexicon?.status !== 'complete'
        || bookLexicon.definitionScanComplete !== true
        || bookLexicon.profileId !== selectedProfile.id
      )
    ) {
      if (settings.scholarAutoScan !== true) {
        throw new Error('Scholar pronunciation and definition scan is required before audiobook generation.');
      }
      const candidates = collectSmartAudioTermCandidates(
        chapters.map((chapter) => chapter.text),
        resolvedPronunciations,
        globalDefinitions,
      );
      definitionPassRan = true;
      try {
        bookLexicon = await resolveSmartAudioBookLexicon({
          profile: selectedProfile,
          candidates,
          existing: bookLexicon?.profileId === selectedProfile.id ? bookLexicon : null,
          onProgress: (partial) => writeBookLexicon(userId, doc.id, partial),
          onUsage: ({ model, batch, tokens }) => {
            serverLogger.info({
              event: 'audiobook.queue.gemini.usage',
              jobId: job.id,
              bookId,
              chapter: null,
              model,
              pass: 'pronunciation_definition_scan',
              batch,
              tokens,
            }, 'Recorded Gemini pronunciation and definition token usage.');
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/\bHTTP (429|503)\b/.test(message)) {
          const jobSettingsParsed = typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : (job.settingsJson || {});
          jobSettingsParsed.nextAttemptAt = Date.now() + 300 * 1000;
          await updateClaimedAudiobookJob(job.id, 'running', {
            status: 'queued',
            createdAt: job.createdAt,
            updatedAt: Date.now(),
            error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
            settingsJson: JSON.stringify(jobSettingsParsed),
          });
          serverLogger.warn({
            event: 'audiobook.queue.scholar_lexicon.rate_limit',
            bookId,
          }, 'Pronunciation and definition auto-scan paused by Gemini API limits.');
          return;
        }
        throw error;
      }
      await writeBookLexicon(userId, doc.id, bookLexicon);

      const termsNeedingGeneratedPronunciations = new Set(
        candidates
          .filter((candidate) => !candidate.pronunciation)
          .map((candidate) => candidate.term),
      );
      const selectedDefaults = Object.fromEntries(
        Object.values(bookLexicon.entries)
          .filter((entry) => !entry.approvedRepair && termsNeedingGeneratedPronunciations.has(entry.term))
          .map((entry) => [entry.term, entry.pronunciation]),
      );
      const mergedProfile = await mergeGeneratedPronunciationsIntoLatestProfile(
        userId,
        selectedProfile.id,
        selectedDefaults,
        pronunciationsAtAutoScanStart,
      );
      selectedProfile = mergedProfile?.profile || selectedProfile;
      resolvedPronunciations = filterKokoroCompatiblePronunciationRecord({
        ...globalPronunciations,
        ...(selectedProfile.pronunciations || {}),
      });
      const resolvedGlobalDefinitions = await readGlobalDefinitions();
      for (const [term, definition] of Object.entries(resolvedGlobalDefinitions)) {
        const entry = bookLexicon.entries[term];
        if (entry && !entry.definition && entry.definitionOmitted !== true) {
          entry.definition = definition;
          entry.definitionOmitted = false;
        }
      }
      await mergeGlobalDefinitions(Object.fromEntries(
        Object.entries(bookLexicon.entries)
          .filter(([term, entry]) => (
            Boolean(entry.definition)
            && entry.definitionOmitted !== true
            && !definitionsBeforeAutoScan.get(term)
          ))
          .map(([term, entry]) => [term, entry.definition]),
      ));
      await writeBookLexicon(userId, doc.id, bookLexicon);
      serverLogger.info({
        event: 'audiobook.queue.scholar_lexicon.completed',
        bookId,
        terms: Object.keys(bookLexicon.entries).length,
        pronunciationsApplied: mergedProfile?.appliedWords.length || 0,
        userEditsPreserved: mergedProfile?.preservedUserEdits.length || 0,
      }, 'Built the Scholar pronunciation and definition lexicon before cleanup.');
    }

    let multiVoiceCharacters: MultiVoiceCastMember[] = [];
    if (selectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE) {
      let readiness = getCharacterMapReadiness(resolvedDocumentSettings.smartAudioCharacters);
      if (!readiness.ready && readiness.unassigned.length > 0 && readiness.map) {
        const metrics = await getDocumentCharacterUsageMetrics(bookId, userId, testNamespace, readiness.map);
        const autoResult = autoAssignMinorCharacterVoices({
          characterMap: readiness.map,
          characterUsageMetrics: metrics,
        });
        if (autoResult.assigned.length > 0) {
          serverLogger.info({
            event: 'audiobook.queue.multivoice.auto_assigned_voices',
            bookId,
            assigned: autoResult.assigned,
          }, 'Auto-assigned recyclable voices to unassigned characters before chapter loop.');

          const [currentDoc] = await db
            .select({ dataJson: documentSettings.dataJson })
            .from(documentSettings)
            .where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, userId)))
            .limit(1);
          const currentSettings = currentDoc?.dataJson
            ? (typeof currentDoc.dataJson === 'string' ? JSON.parse(currentDoc.dataJson) : currentDoc.dataJson)
            : {};
          currentSettings.smartAudioCharacters = autoResult.updatedMap;
          await db.update(documentSettings)
            .set({ dataJson: JSON.stringify(currentSettings) })
            .where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, userId)));
          resolvedDocumentSettings.smartAudioCharacters = autoResult.updatedMap;
          readiness = getCharacterMapReadiness(autoResult.updatedMap);
        }
      }

      if (!readiness.ready || readiness.map?.profileId !== selectedProfile.id) {
        serverLogger.info({ event: 'audiobook.queue.multivoice.waiting_for_voices', bookId }, 'Job is paused waiting for user to map voices in UI');
        await updateClaimedAudiobookJob(job.id, 'running', {
          status: WAITING_FOR_VOICES_STATUS,
          error: 'Review and assign the LitRPG character voices to continue.',
          updatedAt: Date.now(),
        });
        return;
      }
      multiVoiceCharacters = buildMultiVoiceCast(readiness.map);
    } else if (selectedProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
      const storedCast = rawDocumentSettings && typeof rawDocumentSettings === 'object' && !Array.isArray(rawDocumentSettings)
        ? (rawDocumentSettings as Record<string, unknown>).smartAudioCharacters
        : null;
      let readiness = getCloudTtsCharacterMapReadiness(storedCast);
      if (!readiness.ready && readiness.unassigned.length > 0 && readiness.map) {
        const autoResult = autoAssignCloudTtsMinorVoices({
          characterMap: readiness.map,
        });
        if (autoResult.assigned.length > 0) {
          serverLogger.info({
            event: 'audiobook.queue.multivoice.auto_assigned_cloud_voices',
            bookId,
            assigned: autoResult.assigned,
          }, 'Auto-assigned recyclable Cloud voices to unassigned minor characters before chapter loop.');

          const [currentDoc] = await db
            .select({ dataJson: documentSettings.dataJson })
            .from(documentSettings)
            .where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, userId)))
            .limit(1);
          const currentSettings = currentDoc?.dataJson
            ? (typeof currentDoc.dataJson === 'string' ? JSON.parse(currentDoc.dataJson) : currentDoc.dataJson)
            : {};
          currentSettings.smartAudioCharacters = autoResult.updatedMap;
          await db.update(documentSettings)
            .set({ dataJson: JSON.stringify(currentSettings) })
            .where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, userId)));
          resolvedDocumentSettings.smartAudioCharacters = autoResult.updatedMap;
          readiness = getCloudTtsCharacterMapReadiness(autoResult.updatedMap);
        }
      }

      if (!readiness.ready || readiness.map?.profileId !== selectedProfile.id) {
        await updateClaimedAudiobookJob(job.id, 'running', {
          status: WAITING_FOR_VOICES_STATUS,
          error: 'Review and assign the Google Cloud Drama character voices to continue.',
          updatedAt: Date.now(),
        });
        return;
      }
      resolvedDocumentSettings.smartAudioCharacters = readiness.map;
    }

    serverLogger.info({
      event: 'audiobook.queue.smart_audio.plan',
      jobId: job.id,
      bookId,
      worker_mode: selectedProfile?.workerMode || 'standard',
      nats_subject: useSmartAudio
        ? selectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE
          ? 'audiobooks.multivoice.assign'
          : isScholarLikeMode(selectedProfile?.workerMode)
            ? SCHOLAR_NATS_SUBJECT
            : SMART_AUDIO_NATS_SUBJECT
        : null,
      definition_pass_ran: definitionPassRan,
      definitions_found: Object.values(bookLexicon?.entries || {})
        .filter((entry) => Boolean(entry.definition)).length,
      toc_sections_skipped: tocSectionsSkipped,
      cleanup_target_characters: cleanupTargetCharacters,
    }, 'Prepared audiobook cleanup plan.');

    let nc: import("nats").NatsConnection | null = null;
    let sc: import("nats").Codec<string> | null = null;
    if (useSmartAudio) {
      try {
        const { connect, StringCodec } = await import('nats');
        serverLogger.info({ event: 'audiobook.queue.smart_audio.init', bookId }, 'Connecting to NATS for Gemini worker...');
        const natsUrl = process.env.NATS_URL || "nats://127.0.0.1:4222";
        nc = await connect({ servers: natsUrl, maxReconnectAttempts: 1, timeout: 2000 });
        sc = StringCodec();
      } catch (e) {
        serverLogger.warn({ event: 'audiobook.queue.smart_audio.error', error: e }, 'Failed to connect to NATS, smart audio will fail');
      }
    }
    if (useSmartAudio && (!nc || !sc)) {
      throw new Error('Smart Audio was enabled, but the cleanup worker connection could not be established.');
    }

    let continuityState = "Beginning of book.";
    const failedChapterIndexes: number[] = [];

    const markChapterForReview = async (chapterIndex: number, chapterLength: number) => {
      if (!failedChapterIndexes.includes(chapterIndex)) failedChapterIndexes.push(chapterIndex);
      processedLength += chapterLength;
      await updateProgress(Math.floor((processedLength / totalLength) * 100));
    };

    for (const chapter of chapters) {
      // ABORT CHECK: If user cancelled/deleted the job from the UI, abort processing
      if (!await workerStillOwnsAudiobookJob(job.id)) {
        serverLogger.info({ event: 'audiobook.queue.aborted', jobId: job.id }, 'Job was paused, cancelled, or deleted. Aborting worker loop.');
        if (nc) await nc.close();
        return;
      }

      if (!chapter.text.trim()) continue;

      // CRASH RECOVERY: Check if chapter already exists in DB
      const existing = await db.select().from(audiobookChapters).where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId), eq(audiobookChapters.chapterIndex, chapter.index)));
      if (existing.length > 0) {
        processedLength += chapter.text.length;
        await updateProgress(Math.floor((processedLength / totalLength) * 100));
        continue;
      }

      let processedTextForTts = chapter.text;
      

      if (useSmartAudio && nc && sc) {
        const smartAudioProfileId = String(settings.smartAudioProfileId || '');
        const currentProfilesDocument = await readSmartAudioProfilesDocument(userId);
        const currentSelectedProfile = findSmartAudioProfileById(currentProfilesDocument, smartAudioProfileId);
        
        try {
          serverLogger.info({ event: 'audiobook.queue.smart_audio.enabled', bookId, chapter: chapter.index }, 'Triggering Python Gemini worker...');
          
          // Key is stored per-profile; fall back to empty string which causes
          // the Python worker to return {status:"error"} and skip smart audio.
          const geminiApiKey = (currentSelectedProfile?.geminiApiKey || '').trim();

          const backupGeminiApiKey = (currentSelectedProfile?.backupGeminiApiKey || '').trim();
          const currentPronunciations = filterKokoroCompatiblePronunciationRecord({
            ...globalPronunciations,
            ...pronunciationsFromBookLexicon(bookLexicon),
            ...(currentSelectedProfile?.pronunciations || {}),
          });
          const enrichedChapterText = enrichTextFromBookLexicon(
            chapter.cleanupText ?? chapter.text,
            bookLexicon,
            {
              // scholarIncludeDefinitions defaults to true when absent to preserve existing Scholar behavior
              includeDefinitions: isScholarLikeMode(currentSelectedProfile?.workerMode)
                && ((settings as Record<string, unknown>).scholarIncludeDefinitions !== false),
              pronunciationOverrides: currentPronunciations,
            },
          );
          const applicablePronunciations = selectPronunciationsForText(
            enrichedChapterText,
            currentPronunciations,
          );
          const cleanupSourceText = chapter.cleanupText ?? chapter.text;
          const confirmedEndMatter = hasConfirmedSmartAudioEndMatterHint(cleanupSourceText);

          let payload: string;
          let natsSubject: string;

          if (currentSelectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE) {
            payload = JSON.stringify({
              backup_api_key: backupGeminiApiKey,
              user_id: userId,
              api_key: geminiApiKey,
              ai_model: resolveCleanupAiModel(currentSelectedProfile),
              ai_model_fallbacks: resolveCleanupAiModels(currentSelectedProfile).slice(1),
              raw_text: enrichedChapterText,
              characters: multiVoiceCharacters,
              continuity_state: continuityState,
              pronunciations: applicablePronunciations,
              pronunciation_prompt: buildKokoroPronunciationInstructions(currentSelectedProfile),
              final_cleanup_rules: FINAL_SMART_AUDIO_PRONUNCIATION_CHECK,
            });
            natsSubject = 'audiobooks.multivoice.assign';
          } else {
            payload = JSON.stringify({
              backup_api_key: backupGeminiApiKey,
              user_id: userId,
              api_key: geminiApiKey,
              ai_model: resolveCleanupAiModel(currentSelectedProfile),
              ai_model_fallbacks: resolveCleanupAiModels(currentSelectedProfile).slice(1),
              prompt: buildSmartAudioCleanupPrompt(currentSelectedProfile?.customTtsPrompt),
              final_cleanup_rules: FINAL_SMART_AUDIO_PRONUNCIATION_CHECK,
              pronunciation_prompt: buildKokoroPronunciationInstructions(currentSelectedProfile),
              raw_text: enrichedChapterText,
              pronunciations: applicablePronunciations,
              abbreviations: currentSelectedProfile?.abbreviations || {},
              books: currentSelectedProfile?.books || {}
            });
            natsSubject = isScholarLikeMode(currentSelectedProfile?.workerMode)
              ? SCHOLAR_NATS_SUBJECT
              : SMART_AUDIO_NATS_SUBJECT;
          }

          const msg = await nc.request(natsSubject, sc.encode(payload), {
            timeout: resolveSmartAudioNatsTimeoutMs(currentSelectedProfile?.workerMode),
          });
          if (!await workerStillOwnsAudiobookJob(job.id)) throw new AudiobookJobStoppedError();
          const applyAuthoritativeBookTags = (value: unknown): unknown => {
            if (
              currentSelectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE
              || !bookLexicon
              || !value
              || typeof value !== 'object'
              || Array.isArray(value)
            ) return value;
            const result = value as Record<string, unknown>;
            if (typeof result.cleaned_text !== 'string') return value;
            return {
              ...result,
              cleaned_text: enrichTextFromBookLexicon(result.cleaned_text, bookLexicon, {
                includeDefinitions: false,
                pronunciationOverrides: currentPronunciations,
              }),
            };
          };
          let workerResult = applyAuthoritativeBookTags(JSON.parse(sc.decode(msg.data))) as Record<string, unknown>;

          if (workerResult.status === "rate_limit") {
            const cooldownSeconds = typeof workerResult.cooldownSeconds === 'number' && workerResult.cooldownSeconds > 0
              ? workerResult.cooldownSeconds
              : 300;
            serverLogger.warn({ event: 'audiobook.queue.smart_audio.rate_limit', bookId, chapter: chapter.index, cooldownSeconds }, `Python worker reported rate limit. Yielding job with ${cooldownSeconds}s cooldown.`);
            if (nc) await nc.close();
            const jobSettingsParsed = typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : (job.settingsJson || {});
            jobSettingsParsed.nextAttemptAt = Date.now() + cooldownSeconds * 1000;
            await updateClaimedAudiobookJob(job.id, 'running', {
              status: 'queued',
              createdAt: job.createdAt,
              updatedAt: Date.now(),
              error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
              settingsJson: JSON.stringify(jobSettingsParsed),
            });
            return;
          }

          if (workerResult.status === "success") {
            const recovery = await resolveSmartAudioWithValidationRecovery({
              initialResult: workerResult,
              targetedRepair: currentSelectedProfile ? async candidate => {
                const controller = new AbortController();
                let checking = false;
                const check = async () => {
                  if (checking || controller.signal.aborted) return;
                  checking = true;
                  try {
                    if (!await workerStillOwnsAudiobookJob(job.id)) controller.abort();
                    else await updateClaimedAudiobookJob(job.id, 'running', { updatedAt: Date.now() });
                  } finally { checking = false; }
                };
                await check();
                const timer = setInterval(() => { void check().catch(() => controller.abort()); }, 1000);
                try {
                  return await repairSmartAudioWorkerPronunciations(candidate, {
                    profile: currentSelectedProfile,
                    sourceText: cleanupSourceText,
                    dictionary: currentPronunciations,
                    signal: controller.signal,
                    onPronunciationCorrections: async (corrections) => {
                      Object.assign(currentPronunciations, corrections);
                      if (currentSelectedProfile?.id) {
                        await updateSmartAudioProfilePronunciations(userId, currentSelectedProfile.id, corrections);
                      }
                      if (bookLexicon) {
                        let lexiconModified = false;
                        for (const [word, ipa] of Object.entries(corrections)) {
                          const existing = bookLexicon.entries[word];
                          if (!existing || existing.pronunciation !== ipa) {
                            bookLexicon.entries[word] = {
                              term: word,
                              pronunciation: ipa,
                              definition: existing?.definition ?? null,
                              language: /\p{Script=Hebrew}/u.test(word) ? 'biblical_hebrew' : 'koine_greek',
                              approvedRepair: true,
                            };
                            lexiconModified = true;
                          }
                        }
                        if (lexiconModified) {
                          await writeBookLexicon(userId, doc.id, bookLexicon).catch(() => {});
                        }
                      }
                    },
                  });
                } catch (error) {
                  if (controller.signal.aborted) throw new AudiobookJobStoppedError();
                  throw error;
                } finally { clearInterval(timer); }
              } : undefined,
              authoritativePronunciations: currentPronunciations,
              onUnrecoverable: async (rejected, errors) => {
                await savePronunciationFailure({ bookId, userId, chapterIndex: chapter.index, chapterTitle: chapter.title,
                  sourceText: cleanupSourceText, rejected, errors: errors.slice(0, 1), jobId: job.id,
                  profileId: currentSelectedProfile?.id, cast: multiVoiceCharacters, namespace: testNamespace,
                });
              },
              resolve: (candidate) => {
                const multiVoiceResult = currentSelectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE
                  ? resolveMultiVoiceWorkerResult(candidate, multiVoiceCharacters, {
                    authoritativePronunciations: currentPronunciations,
                    allowUnknownSpeakers: true,
                  })
                  : null;
                const resolvedWorkerResult = multiVoiceResult
                  ? { outcome: 'cleaned' as const, text: multiVoiceResult.taggedText }
                  : resolveSmartAudioWorkerResult(candidate, {
                    authoritativePronunciations: currentPronunciations,
                    allowSubstantialOmission: confirmedEndMatter,
                    sourceText: cleanupSourceText,
                    requirePronunciationTagsForForeignScripts: isScholarLikeSmartAudioMode(currentSelectedProfile?.workerMode),
                  });
                return { multiVoiceResult, resolvedWorkerResult };
              },
              requestRepair: async (rejectedResult, validationError) => {
                const requestedModel = resolveCleanupAiModel(currentSelectedProfile);
                const repairModel = resolveSmartAudioValidationRepairModel(requestedModel);
                serverLogger.warn({
                  event: 'audiobook.queue.smart_audio.validation_repair',
                  jobId: job.id,
                  bookId,
                  chapter: chapter.index,
                  requestedModel,
                  repairModel,
                  error: validationError,
                }, 'Smart Audio output failed validation; requesting one correction with the quality-repair model.');
                const repairMessage = await nc.request(
                  natsSubject,
                  sc.encode(buildSmartAudioValidationRepairPayload(
                    payload,
                    rejectedResult,
                    validationError,
                  )),
                  { timeout: resolveSmartAudioNatsTimeoutMs(currentSelectedProfile?.workerMode) },
                );
                return applyAuthoritativeBookTags(JSON.parse(sc.decode(repairMessage.data)));
              },
              sourceFallback: (rejectedResult) => ({
                ...(rejectedResult && typeof rejectedResult === 'object' && !Array.isArray(rejectedResult)
                  ? rejectedResult as Record<string, unknown>
                  : {}),
                status: 'success',
                outcome: 'cleaned',
                cleaned_text: extractNarratableSmartAudioSourceText(cleanupSourceText),
                changelog: 'Smart Audio repeatedly omitted substantial source text; OpenReader preserved the original narratable text.',
                source_fallback: true,
              }),
            });
            if (!await workerStillOwnsAudiobookJob(job.id)) throw new AudiobookJobStoppedError();
            workerResult = recovery.workerResult;
            const { multiVoiceResult, resolvedWorkerResult } = recovery.result;
            
            if (multiVoiceResult?.unknownSpeakers?.length) {
              serverLogger.warn({ event: 'audiobook.queue.multivoice.unknown_speakers', bookId, speakers: multiVoiceResult.unknownSpeakers }, 'Detected unknown speakers in chapter');
              const [currentDocSettings] = await db
                .select({ dataJson: documentSettings.dataJson })
                .from(documentSettings)
                .where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, userId)))
                .limit(1);
              if (currentDocSettings) {
                const currentSettings = typeof currentDocSettings.dataJson === 'string' ? JSON.parse(currentDocSettings.dataJson) : (currentDocSettings.dataJson || {});
                
                const currentMap: SmartAudioCharacterMap = currentSettings.smartAudioCharacters || { schemaVersion: 1, status: 'partial', scannedAt: Date.now(), entries: {} };
                for (const unknownName of multiVoiceResult.unknownSpeakers) {
                  if (!currentMap.entries[unknownName]) {
                    const firstSpeakerSeg = multiVoiceResult.segments.find((s: MultiVoiceSegment) => s.speaker.toLowerCase() === unknownName.toLowerCase());
                    currentMap.entries[unknownName] = {
                      name: unknownName,
                      description: `Auto-detected minor character: ${unknownName}`,
                      sampleText: firstSpeakerSeg?.text?.slice(0, 500) || '',
                    };
                  }
                }

                // Automatically assign recyclable English voices to any unassigned minor characters
                const metrics = await getDocumentCharacterUsageMetrics(bookId, userId, testNamespace, currentMap);
                const autoResult = autoAssignMinorCharacterVoices({
                  characterMap: currentMap,
                  characterUsageMetrics: metrics,
                });

                if (autoResult.assigned.length > 0) {
                  serverLogger.info({
                    event: 'audiobook.queue.multivoice.auto_assigned_voices',
                    bookId,
                    chapter: chapter.index,
                    assigned: autoResult.assigned,
                  }, 'Auto-assigned recyclable voices to newly detected minor characters.');

                  // Remap segments that were temporarily assigned Narrator voice to the newly assigned voice
                  const assignedVoiceByName = new Map<string, string>();
                  for (const a of autoResult.assigned) {
                    assignedVoiceByName.set(a.characterName.toLowerCase(), a.voiceId);
                  }
                  for (const seg of multiVoiceResult.segments) {
                    const assignedVoice = assignedVoiceByName.get(seg.speaker.toLowerCase());
                    if (assignedVoice) {
                      seg.voiceId = assignedVoice;
                    }
                  }
                  for (const a of autoResult.assigned) {
                    if (!multiVoiceCharacters.some((c) => c.name.toLowerCase() === a.characterName.toLowerCase())) {
                      multiVoiceCharacters.push({
                        name: a.characterName,
                        voiceId: a.voiceId,
                        aliases: [],
                      });
                    }
                  }
                  multiVoiceResult.taggedText = renderVoiceSegments(multiVoiceResult.segments);
                  resolvedWorkerResult.text = multiVoiceResult.taggedText;
                }

                currentSettings.smartAudioCharacters = autoResult.updatedMap;
                resolvedDocumentSettings.smartAudioCharacters = autoResult.updatedMap;
                
                const newFlags = [...(currentSettings.smartAudioReviewFlags || [])];
                newFlags.push({
                  id: randomUUID(),
                  chapterIndex: chapter.index,
                  timestampMs: 0,
                  createdAt: Date.now(),
                });
                currentSettings.smartAudioReviewFlags = newFlags;
                
                await db.update(documentSettings).set({ dataJson: JSON.stringify(currentSettings) }).where(and(eq(documentSettings.documentId, job.documentId), eq(documentSettings.userId, userId)));
              }
            }

            if (recovery.sourceFallbackUsed) {
              serverLogger.warn({
                event: 'audiobook.queue.smart_audio.source_fallback',
                jobId: job.id,
                bookId,
                chapter: chapter.index,
                validationErrors: recovery.validationErrors,
              }, 'Smart Audio repeatedly omitted substantial source text; continuing with the original narratable text.');
            } else if (recovery.fallbackUsed) {
              serverLogger.warn({
                event: 'audiobook.queue.smart_audio.pronunciation_fallback',
                jobId: job.id,
                bookId,
                chapter: chapter.index,
                discardedTags: recovery.discardedTags,
                validationErrors: recovery.validationErrors,
              }, 'Discarded unsafe pronunciation markup after the correction pass; continuing with cleaned text.');
            }
            processedTextForTts = resolvedWorkerResult.text;
            if (multiVoiceResult?.continuityState) {
              continuityState = multiVoiceResult.continuityState;
            } else if (typeof workerResult.continuity_state === 'string' && workerResult.continuity_state.trim()) {
              continuityState = workerResult.continuity_state.trim();
            }
            const resolvedChapterTitle = multiVoiceResult?.chapterTitle
              || (typeof workerResult.chapter_title === 'string' ? workerResult.chapter_title.trim() : '');
            if (resolvedChapterTitle) {
              chapter.title = resolvedChapterTitle;
              await db.update(audiobookChapters)
                .set({ title: resolvedChapterTitle })
                .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.chapterIndex, chapter.index)));
            }
            serverLogger.info({
              event: 'audiobook.queue.gemini.usage',
              jobId: job.id,
              bookId,
              chapter: chapter.index,
              requestedModel: resolveCleanupAiModel(currentSelectedProfile),
              model: typeof workerResult.model_used === 'string'
                ? workerResult.model_used
                : resolveCleanupAiModel(currentSelectedProfile),
              pass: 'cleanup',
              worker_mode: currentSelectedProfile?.workerMode || 'standard',
              nats_subject: natsSubject,
              definition_pass_ran: false,
              definitions_found: Object.values(bookLexicon?.entries || {})
                .filter((entry) => Boolean(entry.definition)).length,
              toc_sections_skipped: tocSectionsSkipped,
              tokens: normalizeGeminiTokenUsage(workerResult.usage),
            }, 'Recorded Gemini cleanup token usage.');
            
            if (typeof workerResult.changelog === 'string' && workerResult.changelog) {
              const changelogName = `${String(chapter.index + 1).padStart(4, '0')}__changelog.txt`;
              await putAudiobookObject(bookId, userId, changelogName, Buffer.from(workerResult.changelog, 'utf8'), 'text/plain; charset=utf-8', testNamespace).catch(() => {});
            }
          } else {
            throw new Error(`Python worker returned error: ${workerResult.message || workerResult.status || 'unknown response'}`);
          }
        } catch (e) {
          if (e instanceof AudiobookJobStoppedError) throw e;

          if (e instanceof SmartAudioTargetedRepairError || e instanceof SmartAudioOutputValidationError) {
            serverLogger.warn({
              event: 'audiobook.queue.chapter_held_for_review',
              jobId: job.id,
              bookId,
              chapter: chapter.index,
              error: e.message,
            }, 'Skipping one unrecoverable chapter and continuing audiobook generation.');
            await markChapterForReview(chapter.index, chapter.text.length);
            continue;
          }

          const isNatsTimeout = e instanceof Error && (
            e.message.includes('TIMEOUT') ||
            ('code' in e && (e as { code: string }).code === 'TIMEOUT')
          );

          if (isNatsTimeout) {
            serverLogger.warn({
              event: 'audiobook.queue.smart_audio.nats_timeout_yield',
              jobId: job.id,
              bookId,
              chapter: chapter.index,
            }, 'Smart Audio NATS request timed out. Yielding job to queue with 5-minute cooldown instead of aborting.');
            if (nc) await nc.close();
            const jobSettingsParsed = typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : (job.settingsJson || {});
            jobSettingsParsed.nextAttemptAt = Date.now() + 300 * 1000;
            await updateClaimedAudiobookJob(job.id, 'running', {
              status: 'queued',
              createdAt: job.createdAt,
              updatedAt: Date.now(),
              error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
              settingsJson: JSON.stringify(jobSettingsParsed),
            });
            return;
          }

          serverLogger.error({ event: 'audiobook.queue.smart_audio.failed', error: e }, 'Smart audio processing failed. Aborting generation.');
          if (nc) await nc.close();
          
          const jobSettingsParsed = typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : (job.settingsJson || {});
          const retries = typeof jobSettingsParsed.smartAudioRetries === 'number' ? jobSettingsParsed.smartAudioRetries : 0;
          
          if (retries < 1) {
            jobSettingsParsed.smartAudioRetries = retries + 1;
            serverLogger.info({ event: 'audiobook.queue.smart_audio.retry_scheduled' }, 'Scheduling auto-retry in 5 minutes...');
            
            await updateClaimedAudiobookJob(job.id, 'running', {
              settingsJson: JSON.stringify(jobSettingsParsed), 
              status: 'error', 
              error: e instanceof SmartAudioTargetedRepairError
                ? 'Pronunciation repair API retries were exhausted. Will automatically retry in 5 minutes...'
                : 'Smart audio failed to connect. Will automatically retry in 5 minutes...'
            });
            
            setTimeout(async () => {
              try {
                // If it's still in error state (user hasn't manually cancelled or requeued it)
                const currentJobCheck = await db.select({ status: audiobookJobs.status }).from(audiobookJobs).where(eq(audiobookJobs.id, job.id));
                if (currentJobCheck.length > 0 && currentJobCheck[0].status === 'error') {
                  serverLogger.info({ event: 'audiobook.queue.smart_audio.auto_requeue' }, 'Auto-requeuing delayed smart audio job...');
                  await db.update(audiobookJobs).set({ status: 'queued', error: null, progress: 0 }).where(eq(audiobookJobs.id, job.id));
                }
              } catch (retryErr) {
                serverLogger.error({ event: 'audiobook.queue.smart_audio.auto_requeue.error', error: retryErr }, 'Failed to auto-requeue job');
              }
            }, 5 * 60 * 1000);
            
            return;
          }
          
          throw new Error(`Smart audio processing failed after auto-retry. Error: ${(e as any).message || e}. Job aborted so it can be requeued later.`);
        }
      }
      
      // ABORT END-MATTER: If Gemini confirmed this was end-matter and omitted it!
      const cleanedTrimmed = processedTextForTts.trim();
      const cleanupSource = chapter.cleanupText ?? chapter.text;
      if (!cleanedTrimmed && cleanupSource.includes('end-matter (e.g. bibliography')) {
          serverLogger.info({ event: 'audiobook.queue.smart_audio.end_matter_confirmed', bookId }, 'Gemini confirmed end-matter and omitted it. Halting generation for the rest of the book!');
          break; // Stop generating the rest of the book!
      }
      
      // If the text is empty but it wasn't end-matter (e.g. just a blank page or copyright), we skip TTS but continue to next chapter
      if (!cleanedTrimmed) {
          continue;
      }
      processedTextForTts = validateSmartAudioOutput(processedTextForTts, {
        requirePronunciationTagsForForeignScripts: isScholarLikeSmartAudioMode(selectedProfile?.workerMode),
      });

      // Smart Audio may replace the inherited layout heading with a concise
      // title for this cleanup batch. Encode the file only after that title is
      // known so blob discovery and the chapter database agree.
      const chapterFileName = encodeChapterFileName(chapter.index, chapter.title, format);

      let ttsBuffer: Buffer;
      try {
        if (selectedProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
          try {
            const drama = await generateCloudDramaAudiobook({
              cleanedText: processedTextForTts,
              characterMap: resolvedDocumentSettings.smartAudioCharacters!,
              geminiApiKey: selectedProfile.geminiApiKey || '',
              backupGeminiApiKey: selectedProfile.backupGeminiApiKey,
              directorModel: resolveDramaDirectorModel(selectedProfile),
              serviceAccountJson: selectedProfile.googleCloudServiceAccountJson,
              dramaGeminiTtsSettings: selectedProfile.dramaGeminiTtsSettings,
              priorContinuityState: continuityState,
              ttsModel: typeof settings.ttsModel === 'string' && settings.ttsModel.trim() ? settings.ttsModel : CLOUD_TTS_MODEL,
              ttsModelFallbacks: CLOUD_TTS_FALLBACK_MODELS,
            });
            ttsBuffer = drama.audioBuffer;
            await persistCloudDramaReviewFlags({ documentId: job.documentId, userId, chapterIndex: chapter.index, flags: drama.reviewFlags });
          } catch (error) {
            if (error instanceof CloudDramaGenerationError) {
              await persistCloudDramaReviewFlags({ documentId: job.documentId, userId, chapterIndex: chapter.index, flags: error.reviewFlags });
            } else if (error instanceof DramaDirectorValidationError || (error as { name?: string })?.name === 'DramaDirectorValidationError') {
              const issues = Array.isArray((error as { issues?: string[] }).issues)
                ? (error as { issues: string[] }).issues
                : [error instanceof Error ? error.message : String(error)];
              await persistCloudDramaReviewFlags({
                documentId: job.documentId,
                userId,
                chapterIndex: chapter.index,
                flags: [{
                  kind: 'director-validation-repair',
                  speaker: 'Director',
                  sourceText: processedTextForTts.slice(0, 300),
                  chunkIndex: 0,
                  attempts: 2,
                  reason: `Drama Director output failed validation: ${issues.slice(0, 3).join('; ')}`,
                }],
              }).catch(() => {});
            }
            throw error;
          }
        } else ttsBuffer = await generateQueuedAudiobookTts(
          job.id,
          {
            text: processedTextForTts,
            voice: settings.voice || 'alloy',
            speed: settings.speed || 1,
            format: 'mp3',
            provider: creds!.provider,
            apiKey: creds!.apiKey,
            baseUrl: creds!.baseUrl,
            testNamespace: testNamespace,
          },
          {
            provider: creds!.provider,
            model: typeof settings.ttsModel === 'string'
              ? settings.ttsModel
              : creds!.adminRecord?.defaultModel,
          },
          {
            ttsCacheMaxSizeBytes: runtimeConfig.ttsCacheMaxSizeBytes,
            ttsCacheTtlMs: runtimeConfig.ttsCacheTtlMs,
            ttsUpstreamMaxRetries: runtimeConfig.ttsUpstreamMaxRetries,
            ttsUpstreamTimeoutMs: runtimeConfig.ttsUpstreamTimeoutMs,
          },
        );
      } catch (error) {
        if (error instanceof AudiobookJobStoppedError) throw error;
        const message = error instanceof Error ? error.message : String(error);

        // ── Smart HTTP Errorcode / Quota Handling for Cloud Drama & TTS ───────
        const isCloudTtsQuota = isCloudTtsQuotaExhaustedError(error);
        const isGeminiQuota = /\bHTTP (429|503)\b/.test(message) ||
          /resource_exhausted|quota exceeded|rate limit|too many requests/i.test(message);

        if (isCloudTtsQuota || isGeminiQuota) {
          if (nc) await nc.close();
          const jobSettingsParsed = typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : (job.settingsJson || {});

          const isDaily = isCloudTtsQuota
            ? (error instanceof CloudTtsQuotaExhaustedError ? error.isDailyQuota : true)
            : /daily|quota|credit/i.test(message) || /\b429\b/.test(message);
          const cooldownMs = isDaily
            ? calculateRemainingDailyQuotaMs()
            : 300 * 1000;

          jobSettingsParsed.nextAttemptAt = Date.now() + cooldownMs;

          const pauseMessage = isCloudTtsQuota
            ? GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE
            : GEMINI_RATE_LIMIT_PAUSE_MESSAGE;

          await updateClaimedAudiobookJob(job.id, 'running', {
            status: 'queued',
            createdAt: job.createdAt,
            updatedAt: Date.now(),
            error: pauseMessage,
            settingsJson: JSON.stringify(jobSettingsParsed),
          });

          serverLogger.warn({
            event: isCloudTtsQuota ? 'audiobook.queue.cloud_tts.quota_paused' : 'audiobook.queue.drama_director.rate_limit_paused',
            jobId: job.id,
            bookId,
            chapter: chapter.index,
            cooldownSeconds: Math.round(cooldownMs / 1000),
            error: message,
          }, isCloudTtsQuota
            ? `Google Cloud TTS daily quota/credits exhausted. Pausing audiobook until daily refresh (${Math.round(cooldownMs / 1000)}s).`
            : `Drama Director hit Gemini API limits. Yielding job with ${Math.round(cooldownMs / 1000)}s cooldown.`
          );
          return;
        }

        const issues = (error instanceof DramaDirectorValidationError || (error as { name?: string })?.name === 'DramaDirectorValidationError') && Array.isArray((error as { issues?: string[] }).issues)
          ? (error as { issues: string[] }).issues
          : error instanceof CloudDramaGenerationError
            ? error.reviewFlags.map(f => `${f.speaker ? `[${f.speaker}] ` : ''}${f.reason}`)
            : [`TTS recording failed: ${message}`];
        try {
          await savePronunciationFailure({
            bookId,
            userId,
            chapterIndex: chapter.index,
            chapterTitle: chapter.title,
            sourceText: cleanupSource,
            rejected: { status: 'success', cleaned_text: processedTextForTts },
            errors: issues.length ? issues : [`TTS recording failed: ${message}`],
            jobId: job.id,
            profileId: selectedProfile?.id,
            cast: multiVoiceCharacters,
            namespace: testNamespace,
          });
        } catch (retentionError) {
          serverLogger.error({ event: 'audiobook.pronunciation_failure.save_failed', bookId, chapter: chapter.index, error: retentionError }, 'Could not retain failed chapter for manual review; stopping to avoid an untracked gap.');
          throw retentionError;
        }
        serverLogger.error({
          event: 'audiobook.queue.chapter_tts_failed',
          jobId: job.id,
          bookId,
          chapter: chapter.index,
          error,
        }, 'One chapter failed TTS; continuing audiobook generation.');
        await markChapterForReview(chapter.index, chapter.text.length);
        continue;
      }
      if (!await workerStillOwnsAudiobookJob(job.id)) throw new AudiobookJobStoppedError();

      const contentType = format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
      totalBytes += ttsBuffer.length;
      await putAudiobookObject(bookId, userId, chapterFileName, ttsBuffer, contentType, testNamespace);
      
      // Save the cleaned text so the user can review and edit it later in the new listen UI
      const textFileName = `${String(chapter.index + 1).padStart(4, '0')}__text.txt`;
      await putAudiobookObject(bookId, userId, textFileName, Buffer.from(processedTextForTts, 'utf8'), 'text/plain; charset=utf-8', testNamespace).catch(() => {});
      
      // Save the original text so the user can see what Gemini changed
      const originalFileName = `${String(chapter.index + 1).padStart(4, '0')}__original.txt`;
      await putAudiobookObject(bookId, userId, originalFileName, Buffer.from(chapter.text, 'utf8'), 'text/plain; charset=utf-8', testNamespace).catch(() => {});

      let duration = 0;
      try {
        const { tmpdir } = await import('os');
        const { join } = await import('path');
        const { writeFile, rm } = await import('fs/promises');
        const { ffprobeAudio } = await import('@/lib/server/audiobooks/chapters');
        const tmpPath = join(tmpdir(), 'worker-probe-' + randomUUID() + '.mp3');
        await writeFile(tmpPath, ttsBuffer);
        const probe = await ffprobeAudio(tmpPath);
        duration = probe.durationSec || 0;
        await rm(tmpPath).catch(() => {});
      } catch (e) {
        serverLogger.warn({ event: 'audiobook.queue.probe.failed', error: String(e) }, 'Failed to probe duration');
      }

      try {
        await db.insert(audiobookChapters).values({
          id: randomUUID(),
          bookId,
          userId,
          chapterIndex: chapter.index,
          title: chapter.title,
          duration,
          filePath: chapterFileName,
          format,
        });
      } catch (insertErr: unknown) {
        if (insertErr instanceof Error && insertErr.message.includes('FOREIGN KEY')) {
          serverLogger.info({ event: 'audiobook.queue.aborted', jobId: job.id }, 'Audiobook deleted during chapter generation, aborting.');
          if (nc) await nc.close();
          await db.delete(audiobookJobs).where(eq(audiobookJobs.id, job.id)).catch(() => {});
          return;
        }
        throw insertErr;
      }

      processedLength += chapter.text.length;
      await updateProgress(Math.floor((processedLength / totalLength) * 100));
    }

    if (nc) await nc.close();

    await updateClaimedAudiobookJob(job.id, 'running', {
      status: 'completed',
      completedAt: Date.now(),
      progress: 100,
      error: failedChapterIndexes.length
        ? `${failedChapterIndexes.length} chapter${failedChapterIndexes.length === 1 ? '' : 's'} require${failedChapterIndexes.length === 1 ? 's' : ''} manual review before full-book download.`
        : null,
    });
    await db.update(audiobooks).set({ totalBytes }).where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, userId)));
    serverLogger.info({ event: 'audiobook.queue.complete', jobId: job.id, documentId: job.documentId }, `Successfully completed audiobook job ${job.id}`);

    if (jobSettings.useSmartAudio) {
      // Post-generation pronunciation repair sweep (fire-and-don't-fail)
      try {
        const { runPostGenerationPronunciationSweep } = await import('./post-generation-repair');
        const sweepStats = await runPostGenerationPronunciationSweep(bookId, userId, job.id, jobSettings.smartAudioProfileId);
        serverLogger.info({ event: 'audiobook.postsweep.complete', jobId: job.id, ...sweepStats }, 'Post-generation pronunciation sweep complete');
      } catch (sweepErr) {
        serverLogger.warn({ event: 'audiobook.postsweep.failed', error: String(sweepErr) }, 'Post-generation pronunciation sweep failed (non-fatal)');
      }
    }

    // Fire-and-forget internal request to pre-compile the .m4b so the user doesn't have to wait
    const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3003}`;
    fetch(`${baseUrl}/api/audiobook?bookId=${bookId}&format=m4b&userId=${userId}`, {
      method: 'POST',
      headers: { 'x-internal-secret': INTERNAL_WORKER_SECRET }
    }).catch((e) => {
      serverLogger.warn({ event: 'audiobook.queue.precompile.error', error: String(e) }, 'Failed to trigger background m4b compilation');
    });

  } catch (err: unknown) {
    if (err instanceof AudiobookJobStoppedError) {
      serverLogger.info({ event: 'audiobook.queue.stopped', jobId: job.id }, 'Worker stopped after the job changed state.');
      return;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    
    // Auto-requeue transient connectivity crashes (like server reloads or NATS timeouts)
    if (errorMsg.includes('terminated') || errorMsg.includes('fetch failed') || errorMsg.includes('timeout')) {
      serverLogger.warn({ event: 'audiobook.queue.process.requeue', error: errorMsg }, 'Transient error detected, moving job to back of queue.');
      await updateAudiobookJobIfStatus(job.id, 'running', { status: 'queued', createdAt: Date.now() });
      return;
    }
    
    serverLogger.error({ event: 'audiobook.queue.process.error', error: err instanceof Error ? err.stack : String(err) }, 'Error processing audiobook queue');
    await markError(errorMsg);
  }
}
