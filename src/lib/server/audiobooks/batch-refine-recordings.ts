import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, lt } from 'drizzle-orm';

import { db } from '@/db';
import { audiobookChapters, audiobookJobs, batchRefineChanges, batchRefineRuns } from '@/db/schema';
import { listAdminProviders } from '@/lib/server/admin/providers';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { resolveEffectiveTtsInstructions } from '@/lib/server/admin/tts-instructions';
import {
  deleteAudiobookObject,
  getAudiobookObjectBuffer,
  listAudiobookObjects,
  putAudiobookObject,
} from '@/lib/server/audiobooks/blobstore';
import {
  decodeChapterFileName,
  encodeChapterFileName,
  encodeChapterTitleTag,
  ffprobeAudio,
} from '@/lib/server/audiobooks/chapters';
import { getFFmpegPath } from '@/lib/server/audiobooks/ffmpeg-bin';
import { generateSegmentedAudiobookTtsBuffer } from '@/lib/server/audiobooks/segmented-tts';
import {
  canonicalizeAudiobookSettingsForRuntime,
  coerceAudiobookGenerationSettings,
  type SharedProviderPolicyEntry,
} from '@/lib/server/audiobooks/settings';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { resolveTtsModelForProvider } from '@/lib/shared/tts-provider-policy';
import type { TtsProviderType } from '@/lib/shared/tts-provider-catalog';
import type { TaskContext, TaskResult } from '@/lib/server/tasks/types';
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudiobookFormat } from '@/types/tts';
import { batchRefineTextHash } from './batch-refine-assessment';
import { hasUntaggedScholarForeignScript } from './batch-refine-scholar-safety';
import { canonicalRepairTextFile, PRONUNCIATION_REPAIR_RULE } from '@/lib/shared/pronunciation-issues';
import { assertStoredPronunciationRepair, hasPronunciationReviewOverride } from './pronunciation-repair-validation';
import { recordingVoiceFromReviewNote } from './batch-refine-review-store';

const STALE_RECORDING_MS = 15 * 60 * 1000;

function buildAtempoFilter(speed: number): string {
  const clamped = Math.max(0.5, Math.min(speed, 3));
  if (clamped <= 2) return `atempo=${clamped.toFixed(3)}`;
  return `atempo=2.0,atempo=${(clamped / 2).toFixed(3)}`;
}

function chapterEncodeArgs(
  inputPath: string,
  outputPath: string,
  format: TTSAudiobookFormat,
  postSpeed: number,
  titleTag: string,
): string[] {
  if (format === 'mp3') {
    return [
      '-y',
      '-i',
      inputPath,
      ...(postSpeed !== 1 ? ['-filter:a', buildAtempoFilter(postSpeed)] : []),
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      '-metadata',
      `title=${titleTag}`,
      outputPath,
    ];
  }
  return [
    '-y',
    '-i',
    inputPath,
    ...(postSpeed !== 1 ? ['-filter:a', buildAtempoFilter(postSpeed)] : []),
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-metadata',
    `title=${titleTag}`,
    '-f',
    'mp4',
    outputPath,
  ];
}

async function runFFmpeg(args: string[], signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(getFFmpegPath(), args);
    let finished = false;
    const onAbort = () => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      reject(new Error('ABORTED'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg process exited with code ${code}`));
    });
  });
}

async function readGenerationSettings(
  bookId: string,
  userId: string,
): Promise<{ settings: AudiobookGenerationSettings; runtimeConfig: Awaited<ReturnType<typeof getResolvedRuntimeConfig>> }> {
  const runtimeConfig = await getResolvedRuntimeConfig();
  const parsed = JSON.parse(
    (await getAudiobookObjectBuffer(bookId, userId, 'audiobook.meta.json', null)).toString('utf8'),
  ) as unknown;
  const normalized = coerceAudiobookGenerationSettings(parsed, {
    fallbackProviderRef: runtimeConfig.defaultTtsProvider,
  });
  if (!normalized.settings) throw new Error('The existing audiobook settings are missing or invalid.');

  let settings = normalized.settings;
  if (runtimeConfig.restrictUserApiKeys) {
    const sharedProviders: SharedProviderPolicyEntry[] = (await listAdminProviders())
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        slug: entry.slug,
        providerType: entry.providerType,
        defaultModel: entry.defaultModel,
        defaultInstructions: entry.defaultInstructions,
      }));
    settings = canonicalizeAudiobookSettingsForRuntime({
      settings,
      restrictUserApiKeys: true,
      fallbackProviderRef: runtimeConfig.defaultTtsProvider,
      showAllProviderModels: runtimeConfig.showAllProviderModels,
      sharedProviders,
    });
  }
  return { settings, runtimeConfig };
}

async function deleteCombinedAudiobook(bookId: string, userId: string): Promise<void> {
  await Promise.all([
    'complete.mp3',
    'complete.m4b',
    'complete.mp3.manifest.json',
    'complete.m4b.manifest.json',
  ].map((fileName) => deleteAudiobookObject(bookId, userId, fileName, null).catch(() => {})));
}

async function removeApprovedEmptyChapter(input: {
  bookId: string;
  userId: string;
  chapterIndex: number;
  objectNames: string[];
}): Promise<void> {
  const prefix = `${String(input.chapterIndex + 1).padStart(4, '0')}__`;
  await Promise.all(input.objectNames
    .filter((fileName) => fileName.startsWith(prefix) && (fileName.endsWith('.mp3') || fileName.endsWith('.m4b')))
    .map((fileName) => deleteAudiobookObject(input.bookId, input.userId, fileName, null).catch(() => {})));
  await deleteCombinedAudiobook(input.bookId, input.userId);
  await db.delete(audiobookChapters).where(and(
    eq(audiobookChapters.bookId, input.bookId),
    eq(audiobookChapters.userId, input.userId),
    eq(audiobookChapters.chapterIndex, input.chapterIndex),
  ));
}

async function recordApprovedChange(
  change: typeof batchRefineChanges.$inferSelect,
  signal: AbortSignal,
): Promise<void> {
  const currentText = (await getAudiobookObjectBuffer(
    change.documentId,
    change.userId,
    canonicalRepairTextFile(change.textFileName),
    null,
  )).toString('utf8');
  if (batchRefineTextHash(currentText) !== change.proposedTextHash) {
    throw new Error('Approved text changed before recording began. Review and approve the latest text again.');
  }
  const runRows = await db.select({ profileCategory: batchRefineRuns.profileCategory, rule: batchRefineRuns.rule })
    .from(batchRefineRuns)
    .where(and(
      eq(batchRefineRuns.id, change.runId),
      eq(batchRefineRuns.userId, change.userId),
    ))
    .limit(1);
  const pronunciationRepair = runRows[0]?.rule === PRONUNCIATION_REPAIR_RULE;
  const overridePronunciationReview = pronunciationRepair && hasPronunciationReviewOverride(change.reviewNote);
  const assertRepairStillCurrent = async () => {
    if (!pronunciationRepair) return;
    const jobs = await db.select({ status: audiobookJobs.status }).from(audiobookJobs).where(and(eq(audiobookJobs.documentId, change.documentId), eq(audiobookJobs.userId, change.userId)));
    if (jobs.some((job: { status: string }) => job.status === 'running' || job.status === 'queued')) throw new Error('Pause generation before recording the approved pronunciation repair, then retry this recording.');
    const latestText = (await getAudiobookObjectBuffer(change.documentId, change.userId, canonicalRepairTextFile(change.textFileName), null)).toString('utf8');
    if (batchRefineTextHash(latestText) !== change.proposedTextHash) throw new Error('Chapter changed during recording; replacement was not promoted.');
    if (change.textFileName.endsWith('__rejected.txt')) {
      const rejected = (await getAudiobookObjectBuffer(change.documentId, change.userId, change.textFileName, null)).toString('utf8');
      if (batchRefineTextHash(rejected) !== change.sourceTextHash) throw new Error('A newer failed attempt replaced this proposal. Scan again.');
    }
  };
  if (pronunciationRepair) {
    const overrideMarker = change.reviewNote?.match(/\[Reviewer override: source-evidence issue IDs=([^;]+);/u)?.[1];
    const fullManualOverride = change.reviewNote?.includes('[Reviewer override: entire manual edit;') === true;
    await assertStoredPronunciationRepair({ bookId: change.documentId, userId: change.userId, fileName: change.textFileName, previous: change.previousText, proposed: currentText,
      allowSourceEvidenceOverride: overrideMarker === 'all' || change.reviewNote?.includes('[Reviewer override: source-evidence validation') === true,
      overrideIssueIds: overrideMarker && overrideMarker !== 'all' ? overrideMarker.split(',').filter(Boolean) : undefined,
      allowFullManualOverride: fullManualOverride, overridePronunciationReview });
    await assertRepairStillCurrent();
  }
  if (
    runRows[0]?.profileCategory === 'scholar'
    && !overridePronunciationReview
    && hasUntaggedScholarForeignScript(currentText)
  ) {
    throw new Error('Scholar recording blocked: the approved text contains untagged Greek or Hebrew, or an editorial word split across pronunciation tags.');
  }

  const objects = await listAudiobookObjects(change.documentId, change.userId, null);
  const objectNames = objects.map((object) => object.fileName);
  if (!currentText.trim()) {
    await removeApprovedEmptyChapter({
      bookId: change.documentId,
      userId: change.userId,
      chapterIndex: change.chapterIndex,
      objectNames,
    });
    return;
  }

  const chapterRows = await db.select().from(audiobookChapters).where(and(
    eq(audiobookChapters.bookId, change.documentId),
    eq(audiobookChapters.userId, change.userId),
    eq(audiobookChapters.chapterIndex, change.chapterIndex),
  )).limit(1);
  const storedChapter = chapterRows[0];
  const existingObject = objects
    .map((object) => ({ object, decoded: decodeChapterFileName(object.fileName) }))
    .filter((candidate) => candidate.decoded?.index === change.chapterIndex)
    .sort((left, right) => left.object.fileName.localeCompare(right.object.fileName))
    .at(-1);

  const { settings, runtimeConfig } = await readGenerationSettings(change.documentId, change.userId);
  const format = (storedChapter?.format || existingObject?.decoded?.format || settings.format) as TTSAudiobookFormat;
  const chapterTitle = storedChapter?.title || existingObject?.decoded?.title || change.chapterTitle;
  const credentials = await resolveTtsCredentials({
    providerHeader: settings.providerRef,
    apiKeyHeader: null,
    baseUrlHeader: null,
    fallbackProvider: runtimeConfig.defaultTtsProvider,
    restrictUserApiKeys: runtimeConfig.restrictUserApiKeys,
  });
  if ('error' in credentials) throw new Error(`Could not resolve the saved TTS provider: ${credentials.error}`);

  const effectiveProviderRef = credentials.adminRecord?.slug || settings.providerRef;
  const model = resolveTtsModelForProvider({
    providerRef: effectiveProviderRef,
    providerType: credentials.provider as TtsProviderType,
    model: settings.ttsModel,
    sharedProviders: credentials.adminRecord ? [credentials.adminRecord] : [],
    fallbackProviderRef: runtimeConfig.defaultTtsProvider,
    showAllProviderModels: runtimeConfig.showAllProviderModels,
  });
  const instructions = resolveEffectiveTtsInstructions({
    model,
    requestInstructions: settings.ttsInstructions,
    sharedDefaultInstructions: credentials.adminRecord?.defaultInstructions,
  });

  const rawAudio = await generateSegmentedAudiobookTtsBuffer({
    text: currentText,
    voice: recordingVoiceFromReviewNote(change.reviewNote) || settings.voice,
    speed: settings.nativeSpeed,
    format: 'mp3',
    model,
    instructions,
    language: settings.language,
    provider: credentials.provider,
    apiKey: credentials.apiKey,
    baseUrl: credentials.baseUrl,
  }, signal, {
    ttsCacheMaxSizeBytes: runtimeConfig.ttsCacheMaxSizeBytes,
    ttsCacheTtlMs: runtimeConfig.ttsCacheTtlMs,
    ttsUpstreamMaxRetries: runtimeConfig.ttsUpstreamMaxRetries,
    ttsUpstreamTimeoutMs: runtimeConfig.ttsUpstreamTimeoutMs,
  });

  const workDir = await mkdtemp(join(tmpdir(), 'openreader-batch-refine-recording-'));
  try {
    const inputPath = join(workDir, 'input.mp3');
    const outputPath = join(workDir, `chapter.${format}`);
    await writeFile(inputPath, rawAudio);
    await runFFmpeg(
      chapterEncodeArgs(
        inputPath,
        outputPath,
        format,
        Number.isFinite(settings.postSpeed) ? settings.postSpeed : 1,
        encodeChapterTitleTag(change.chapterIndex, chapterTitle),
      ),
      signal,
    );
    const probe = await ffprobeAudio(outputPath, signal);
    const finalBytes = await readFile(outputPath);
    const finalName = encodeChapterFileName(change.chapterIndex, chapterTitle, format);

    await assertRepairStillCurrent();

    // The existing chapter remains playable until the complete replacement has
    // been generated. This Put is the promotion point.
    await putAudiobookObject(
      change.documentId,
      change.userId,
      finalName,
      finalBytes,
      format === 'mp3' ? 'audio/mpeg' : 'audio/mp4',
      null,
    );

    const prefix = `${String(change.chapterIndex + 1).padStart(4, '0')}__`;
    await Promise.all(objectNames
      .filter((fileName) => fileName.startsWith(prefix)
        && (fileName.endsWith('.mp3') || fileName.endsWith('.m4b'))
        && fileName !== finalName)
      .map((fileName) => deleteAudiobookObject(change.documentId, change.userId, fileName, null).catch(() => {})));
    await deleteCombinedAudiobook(change.documentId, change.userId);

    const originalName = change.textFileName.replace('__rejected.txt', '__original.txt');
    if (pronunciationRepair && change.textFileName.endsWith('__rejected.txt') && !objectNames.includes(originalName)) {
      const metadataName = change.textFileName.replace('__rejected.txt', '__pronunciation_failure.json');
      const metadata = JSON.parse((await getAudiobookObjectBuffer(change.documentId, change.userId, metadataName, null)).toString('utf8'));
      if (typeof metadata.sourceText === 'string') await putAudiobookObject(change.documentId, change.userId, originalName, Buffer.from(metadata.sourceText), 'text/plain; charset=utf-8', null);
    }

    await db.insert(audiobookChapters).values({
      id: storedChapter?.id || `${change.documentId}-${change.chapterIndex}`,
      bookId: change.documentId,
      userId: change.userId,
      chapterIndex: change.chapterIndex,
      title: chapterTitle,
      duration: probe.durationSec || 0,
      filePath: finalName,
      format,
    }).onConflictDoUpdate({
      target: [audiobookChapters.id, audiobookChapters.userId],
      set: {
        title: chapterTitle,
        duration: probe.durationSec || 0,
        filePath: finalName,
        format,
      },
    });
    if (pronunciationRepair && change.textFileName.endsWith('__rejected.txt')) {
      await Promise.all([
        deleteAudiobookObject(change.documentId, change.userId, change.textFileName, null).catch(() => {}),
        deleteAudiobookObject(change.documentId, change.userId, change.textFileName.replace('__rejected.txt', '__pronunciation_failure.json'), null).catch(() => {}),
      ]);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function claimNextQueuedChange() {
  const candidates = await db.select().from(batchRefineChanges)
    .where(and(
      eq(batchRefineChanges.decision, 'approved'),
      eq(batchRefineChanges.audioStatus, 'queued'),
    ))
    .orderBy(asc(batchRefineChanges.updatedAt))
    .limit(1);
  const candidate = candidates[0];
  if (!candidate) return null;
  const claimed = await db.update(batchRefineChanges).set({
    audioStatus: 'running',
    audioError: null,
    updatedAt: Date.now(),
  }).where(and(
    eq(batchRefineChanges.id, candidate.id),
    eq(batchRefineChanges.decision, 'approved'),
    eq(batchRefineChanges.audioStatus, 'queued'),
  )).returning();
  return claimed[0] || null;
}

export async function processBatchRefineRecordingQueue(context: TaskContext): Promise<TaskResult> {
  await db.update(batchRefineChanges).set({
    audioStatus: 'queued',
    updatedAt: Date.now(),
  }).where(and(
    eq(batchRefineChanges.decision, 'approved'),
    eq(batchRefineChanges.audioStatus, 'running'),
    lt(batchRefineChanges.updatedAt, Date.now() - STALE_RECORDING_MS),
  ));

  let completed = 0;
  let failed = 0;
  while (!context.signal.aborted && Date.now() < context.deadlineAt) {
    const change = await claimNextQueuedChange();
    if (!change) break;
    try {
      await recordApprovedChange(change, context.signal);
      await db.update(batchRefineChanges).set({
        audioStatus: 'completed',
        audioError: null,
        audioCompletedAt: Date.now(),
        updatedAt: Date.now(),
      }).where(eq(batchRefineChanges.id, change.id));
      completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update(batchRefineChanges).set({
        audioStatus: 'error',
        audioError: message.slice(0, 1000),
        updatedAt: Date.now(),
      }).where(eq(batchRefineChanges.id, change.id));
      serverLogger.error({
        event: 'audiobook.batch_refine.recording_failed',
        changeId: change.id,
        documentId: change.documentId,
        chapterIndex: change.chapterIndex,
        error: errorToLog(error),
      }, 'An approved Batch Refine change could not be recorded.');
      failed += 1;
    }
  }
  return { summary: `Recorded ${completed} approved Batch Refine change(s); ${failed} failed.`, completed, failed };
}
