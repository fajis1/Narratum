import { NextRequest, NextResponse } from 'next/server';
import { repairSmartAudioWorkerPronunciations } from '@/lib/server/audiobooks/smart-audio-targeted-repair';
import { savePronunciationFailure } from '@/lib/server/audiobooks/pronunciation-failures';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { connect, StringCodec } from 'nats';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, audiobookChapters, adminSettings, documentSettings } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { rateLimiter, resolveRateLimitThresholds } from '@/lib/server/rate-limit/rate-limiter';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import {
  deleteAudiobookObject,
  getAudiobookObjectBuffer,
  isMissingBlobError,
  listAudiobookObjects,
  putAudiobookObject,
} from '@/lib/server/audiobooks/blobstore';
import {
  decodeChapterFileName,
  encodeChapterFileName,
  encodeChapterTitleTag,
  ffprobeAudio,
} from '@/lib/server/audiobooks/chapters';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { getFFmpegPath } from '@/lib/server/audiobooks/ffmpeg-bin';
import { generateSegmentedAudiobookTtsBuffer } from '@/lib/server/audiobooks/segmented-tts';
import { CloudDramaGenerationError, generateCloudDramaAudiobook } from '@/lib/server/audiobooks/cloud-drama';
import { persistCloudDramaReviewFlags } from '@/lib/server/audiobooks/cloud-drama-review';
import { getCloudTtsCharacterMapReadiness } from '@/lib/server/smart-audio/google-cloud-cast-helpers';
import { resolveSmartAudioNatsTimeoutMs } from '@/lib/server/audiobooks/smart-audio-timeout';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { resolveEffectiveTtsInstructions } from '@/lib/server/admin/tts-instructions';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from '@/lib/server/tts/upstream-response';
import { defaultVoiceForProviderType, resolveTtsModelForProvider, resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { isBuiltInTtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { listAdminProviders } from '@/lib/server/admin/providers';
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudiobookFormat } from '@/types/tts';
import {
  canonicalizeAudiobookSettingsForRuntime,
  coerceAudiobookGenerationSettings,
  type SharedProviderPolicyEntry,
} from '@/lib/server/audiobooks/settings';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  findSmartAudioProfileById,
  readSmartAudioProfilesDocument,
} from '@/lib/server/smart-audio-profiles';
import {
  buildKokoroPronunciationInstructions,
  filterKokoroCompatiblePronunciationRecord,
} from '@/lib/shared/kokoro-pronunciation-policy';
import {
  resolveCleanupAiModel,
  resolveCleanupAiModels,
  resolveSmartAudioValidationRepairModel,
} from '@/lib/shared/smart-audio-models';
import {
  collectSmartAudioTermCandidates,
  enrichTextFromBookLexicon,
  pronunciationsFromBookLexicon,
  readBookLexicon,
  resolveSmartAudioBookLexicon,
  selectPronunciationsForText,
  writeBookLexicon,
} from '@/lib/server/smart-audio/book-lexicon';
import { readGlobalDefinitions } from '@/lib/server/smart-audio/global-definition-library';
import { normalizeGeminiTokenUsage } from '@/lib/server/smart-audio/gemini-usage';
import {
  buildSmartAudioCleanupPrompt,
  extractNarratableSmartAudioSourceText,
  FINAL_SMART_AUDIO_PRONUNCIATION_CHECK,
  isScholarLikeSmartAudioMode,
  resolveSmartAudioWorkerResult,
  validateSmartAudioOutput,
} from '@/lib/shared/smart-audio-cleanup';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import {
  buildMultiVoiceCast,
  getCharacterMapReadiness,
  MULTI_VOICE_WORKER_MODE,
  DRAMA_GEMINI_TTS_WORKER_MODE,
  resolveMultiVoiceWorkerResult,
  type MultiVoiceCastMember,
} from '@/lib/shared/multi-voice';
import { DEFAULT_DOCUMENT_SETTINGS, type SmartAudioCharacterMap } from '@/types/document-settings';
import { isKokoroModel } from '@/lib/shared/kokoro';
import {
  buildSmartAudioValidationRepairPayload,
  resolveSmartAudioWithValidationRecovery,
} from '@/lib/server/audiobooks/smart-audio-validation-recovery';

const SMART_AUDIO_NATS_SUBJECT = 'audiobooks.gemini.clean';

export const dynamic = 'force-dynamic';

function contentDispositionAttachment(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

interface ConversionRequest {
  chapterTitle: string;
  text: string;
  bookId?: string;
  documentId?: string;
  format?: TTSAudiobookFormat;
  chapterIndex?: number;
  settings?: unknown;
  useSmartAudio?: boolean;
}

type ChapterObject = {
  index: number;
  title: string;
  format: TTSAudiobookFormat;
  fileName: string;
};

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
const PROBLEM_TYPES = {
  dailyQuotaExceeded: 'https://openreader.app/problems/daily-quota-exceeded',
  upstreamRateLimited: 'https://openreader.app/problems/upstream-rate-limited',
} as const;

type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  [key: string]: unknown;
};

function attachDeviceIdCookie(response: NextResponse, deviceId: string | null, didCreate: boolean) {
  if (didCreate && deviceId) {
    setDeviceIdCookie(response, deviceId);
  }
}

function formatLimitForHint(limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return String(limit);
  if (limit >= 1_000_000) {
    const m = limit / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (limit >= 1_000) return `${Math.round(limit / 1_000)}K`;
  return String(limit);
}

function isSafeId(value: string): boolean {
  return SAFE_ID_REGEX.test(value);
}

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Audiobooks storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function normalizeNativeSpeedForSettings(settings: AudiobookGenerationSettings): AudiobookGenerationSettings {
  return resolveTtsProviderModelPolicy({
    providerRef: settings.providerRef,
    providerType: settings.providerType,
    model: settings.ttsModel,
  }).supportsNativeModelSpeed
    ? settings
    : { ...settings, nativeSpeed: 1 };
}

function chapterFileMimeType(format: TTSAudiobookFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
}

function buildAtempoFilter(speed: number): string {
  const clamped = Math.max(0.5, Math.min(speed, 3));
  if (clamped <= 2) return `atempo=${clamped.toFixed(3)}`;
  const second = clamped / 2;
  return `atempo=2.0,atempo=${second.toFixed(3)}`;
}

function listChapterObjects(objectNames: string[]): ChapterObject[] {
  const chapters = objectNames
    .filter((name) => !name.startsWith('complete.'))
    .map((fileName) => {
      const decoded = decodeChapterFileName(fileName);
      if (!decoded) return null;
      return {
        index: decoded.index,
        title: decoded.title,
        format: decoded.format,
        fileName,
      } satisfies ChapterObject;
    })
    .filter((value): value is ChapterObject => Boolean(value))
    .sort((a, b) => a.index - b.index);

  const deduped = new Map<number, ChapterObject>();
  for (const chapter of chapters) {
    const existing = deduped.get(chapter.index);
    if (!existing || chapter.fileName > existing.fileName) {
      deduped.set(chapter.index, chapter);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.index - b.index);
}

function streamBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

async function runFFmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), args);
    let finished = false;

    const onAbort = () => {
      if (finished) return;
      finished = true;
      try {
        ffmpeg.kill('SIGKILL');
      } catch {}
      reject(new Error('ABORTED'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    ffmpeg.stderr.on('data', (data) => {
      serverLogger.warn({
        event: 'audiobook.chapter.ffmpeg.stderr',
        degraded: true,
        step: 'ffmpeg',
        stderr: String(data),
      }, 'ffmpeg stderr');
    });

    ffmpeg.on('close', (code) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

function chapterEncodeArgs(
  inputPath: string,
  outputPath: string,
  format: TTSAudiobookFormat,
  postSpeed: number,
  titleTag: string,
): string[] {
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
    '-f',
    'mp3',
    outputPath,
  ];
}

function findChapterFileNameByIndex(fileNames: string[], index: number): { fileName: string; title: string; format: 'mp3' | 'm4b' } | null {
  const matches = fileNames
    .map((fileName) => {
      const decoded = decodeChapterFileName(fileName);
      if (!decoded) return null;
      if (decoded.index !== index) return null;
      return { fileName, title: decoded.title, format: decoded.format };
    })
    .filter((value): value is { fileName: string; title: string; format: 'mp3' | 'm4b' } => Boolean(value))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));

  return matches.at(-1) ?? null;
}

export async function POST(request: NextRequest) {
  let workDir: string | null = null;
  let didCreateDeviceIdCookie = false;
  let deviceIdToSet: string | null = null;
  let providerForError: string | null = null;
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const data: ConversionRequest = await request.json();
    const requestedFormat = data.format || 'm4b';
    if (!data.text || typeof data.text !== 'string') {
      return NextResponse.json({ error: 'Missing text for TTS generation' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { user } = ctxOrRes;
    const storageUserId = ctxOrRes.userId;
    const runtimeConfig = await getResolvedRuntimeConfig();
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const bookId = data.bookId || randomUUID();
    const sourceDocumentId = data.documentId || bookId;

    if (!isSafeId(bookId) || !isSafeId(sourceDocumentId)) {
      return NextResponse.json({ error: 'Invalid bookId or documentId parameter' }, { status: 400 });
    }

    await db
      .insert(audiobooks)
      .values({
        id: bookId,
        userId: storageUserId,
        title: data.chapterTitle || 'Untitled Audiobook',
      })
      .onConflictDoNothing();

    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const objectNames = objects.map((item) => item.fileName);
    const existingChapters = listChapterObjects(objectNames);
    const hasChapters = existingChapters.length > 0;

    let normalizedExistingSettings: AudiobookGenerationSettings | undefined;
    let existingSettingsNeedsMigration = false;
    try {
      const parsedSettings = JSON.parse(
        (await getAudiobookObjectBuffer(bookId, storageUserId, 'audiobook.meta.json', testNamespace)).toString('utf8'),
      ) as unknown;
      const existingResult = coerceAudiobookGenerationSettings(parsedSettings, {
        fallbackProviderRef: runtimeConfig.defaultTtsProvider,
      });
      if (!existingResult.settings) {
        serverLogger.error({
          event: 'audiobook.chapter.meta_settings.invalid',
          bookId,
          storageUserId,
          error: {
            name: 'AudiobookMetaSettingsInvalid',
            message: 'Invalid audiobook.meta.json settings payload',
          },
        }, 'Invalid audiobook.meta.json settings payload');
        return errorResponse(new Error('Invalid audiobook metadata settings payload'), {
          apiErrorMessage: 'Invalid audiobook metadata settings',
          normalize: { code: 'AUDIOBOOK_CHAPTER_META_SETTINGS_INVALID', errorClass: 'validation', httpStatus: 500 },
        });
      }
      normalizedExistingSettings = normalizeNativeSpeedForSettings(existingResult.settings);
      existingSettingsNeedsMigration = existingResult.migrated;
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      normalizedExistingSettings = undefined;
    }

    const incomingSettings = (() => {
      if (data.settings === undefined) {
        return undefined;
      }
      const incomingResult = coerceAudiobookGenerationSettings(data.settings, {
        fallbackProviderRef: runtimeConfig.defaultTtsProvider,
      });
      if (!incomingResult.settings) {
        if (typeof data.settings === 'object' && data.settings !== null && !('providerRef' in data.settings) && !('ttsProvider' in data.settings)) {
          return undefined;
        }
        return null;
      }
      return normalizeNativeSpeedForSettings(incomingResult.settings);
    })();

    if (incomingSettings === null) {
      return NextResponse.json({ error: 'Invalid audiobook settings payload' }, { status: 400 });
    }

    const sharedProviders: SharedProviderPolicyEntry[] = runtimeConfig.restrictUserApiKeys
      ? (await listAdminProviders())
          .filter((entry) => entry.enabled)
          .map((entry) => ({
            slug: entry.slug,
            providerType: entry.providerType,
            defaultModel: entry.defaultModel,
            defaultInstructions: entry.defaultInstructions,
          }))
      : [];

    if (runtimeConfig.restrictUserApiKeys && normalizedExistingSettings) {
      const next = canonicalizeAudiobookSettingsForRuntime({
        settings: normalizedExistingSettings,
        restrictUserApiKeys: runtimeConfig.restrictUserApiKeys,
        fallbackProviderRef: runtimeConfig.defaultTtsProvider,
        showAllProviderModels: runtimeConfig.showAllProviderModels,
        sharedProviders,
      });
      if (JSON.stringify(next) !== JSON.stringify(normalizedExistingSettings)) {
        existingSettingsNeedsMigration = true;
      }
      normalizedExistingSettings = next;
    }

    let normalizedIncomingSettings = incomingSettings;
    if (runtimeConfig.restrictUserApiKeys && normalizedIncomingSettings) {
      normalizedIncomingSettings = canonicalizeAudiobookSettingsForRuntime({
        settings: normalizedIncomingSettings,
        restrictUserApiKeys: runtimeConfig.restrictUserApiKeys,
        fallbackProviderRef: runtimeConfig.defaultTtsProvider,
        showAllProviderModels: runtimeConfig.showAllProviderModels,
        sharedProviders,
      });
    }

    if (normalizedExistingSettings && existingSettingsNeedsMigration) {
      try {
        await putAudiobookObject(
          bookId,
          storageUserId,
          'audiobook.meta.json',
          Buffer.from(JSON.stringify(normalizedExistingSettings, null, 2), 'utf8'),
          'application/json; charset=utf-8',
          testNamespace,
        );
      } catch (error) {
        serverLogger.warn({
          event: 'audiobook.chapter.meta_settings.persist_migration_failed',
          degraded: true,
          step: 'persist_migrated_settings',
          bookId,
          storageUserId,
          error: errorToLog(error),
        }, 'Failed to persist migrated audiobook metadata settings');
      }
    }

    const mergedSettings = normalizedExistingSettings && normalizedIncomingSettings
      ? normalizeNativeSpeedForSettings({
          ...normalizedExistingSettings,
          ...normalizedIncomingSettings,
        })
      : normalizedExistingSettings ?? normalizedIncomingSettings;

    if (normalizedExistingSettings && hasChapters && normalizedIncomingSettings) {
      const mismatch =
        normalizedExistingSettings.providerRef !== normalizedIncomingSettings.providerRef ||
        normalizedExistingSettings.providerType !== normalizedIncomingSettings.providerType ||
        normalizedExistingSettings.ttsModel !== normalizedIncomingSettings.ttsModel ||
        normalizedExistingSettings.voice !== normalizedIncomingSettings.voice ||
        normalizedExistingSettings.nativeSpeed !== normalizedIncomingSettings.nativeSpeed ||
        normalizedExistingSettings.postSpeed !== normalizedIncomingSettings.postSpeed ||
        normalizedExistingSettings.format !== normalizedIncomingSettings.format ||
        (normalizedExistingSettings.ttsInstructions || '') !== (normalizedIncomingSettings.ttsInstructions || '') ||
        (normalizedExistingSettings.language || '') !== (normalizedIncomingSettings.language || '');
      if (mismatch) {
        return NextResponse.json({ error: 'Audiobook settings mismatch', settings: normalizedExistingSettings }, { status: 409 });
      }
    }

    const existingFormats = new Set(existingChapters.map((chapter) => chapter.format));
    if (existingFormats.size > 1) {
      return NextResponse.json({ error: 'Mixed chapter formats detected; reset the audiobook to continue' }, { status: 400 });
    }

    const format: TTSAudiobookFormat =
      (existingFormats.values().next().value as TTSAudiobookFormat | undefined) ??
      mergedSettings?.format ??
      requestedFormat;
    const rawPostSpeed = mergedSettings?.postSpeed ?? 1;
    const postSpeed = Number.isFinite(Number(rawPostSpeed)) ? Number(rawPostSpeed) : 1;

    let chapterIndex: number;
    if (data.chapterIndex !== undefined) {
      const normalized = Number(data.chapterIndex);
      if (!Number.isInteger(normalized) || normalized < 0) {
        return NextResponse.json({ error: 'Invalid chapterIndex parameter' }, { status: 400 });
      }
      chapterIndex = normalized;
    } else {
      const indices = existingChapters.map((c) => c.index);
      let next = 0;
      for (const idx of indices) {
        if (idx === next) {
          next++;
        } else if (idx > next) {
          break;
        }
      }
      chapterIndex = next;
    }

    const requestedProvider = request.headers.get('x-tts-provider')
      || mergedSettings?.providerRef
      || 'openai';
    providerForError = requestedProvider;
    const credResolved = await resolveTtsCredentials({
      providerHeader: requestedProvider,
      apiKeyHeader: request.headers.get('x-openai-key'),
      baseUrlHeader: request.headers.get('x-openai-base-url'),
      fallbackProvider: runtimeConfig.defaultTtsProvider,
      restrictUserApiKeys: runtimeConfig.restrictUserApiKeys,
    });
    if ('error' in credResolved) {
      if (credResolved.error === 'no_shared_provider_configured') {
        return NextResponse.json(
          { error: 'User API keys are restricted and no shared provider is configured.' },
          { status: 503 },
        );
      }
      return NextResponse.json(
        { error: `Unknown or disabled TTS provider: ${credResolved.slug}` },
        { status: 404 },
      );
    }
    const provider = credResolved.provider;
    if (!isBuiltInTtsProviderId(provider)) {
      return errorResponse(new Error(`Unsupported TTS provider type: ${provider}`), {
        apiErrorMessage: `Unsupported TTS provider type: ${provider}`,
        normalize: { code: 'AUDIOBOOK_CHAPTER_UNSUPPORTED_PROVIDER', errorClass: 'validation', httpStatus: 500 },
      });
    }
    const openApiKey = credResolved.apiKey;
    const openApiBaseUrl = credResolved.baseUrl;
    const effectiveProviderRef = credResolved.adminRecord?.slug || requestedProvider;
    const model = resolveTtsModelForProvider({
      providerRef: effectiveProviderRef,
      providerType: provider,
      model: mergedSettings?.ttsModel,
      sharedProviders: credResolved.adminRecord ? [credResolved.adminRecord] : [],
      fallbackProviderRef: runtimeConfig.defaultTtsProvider,
      showAllProviderModels: runtimeConfig.showAllProviderModels,
    });
    const voice = mergedSettings?.voice || defaultVoiceForProviderType(provider);
    const rawNativeSpeed = mergedSettings?.nativeSpeed ?? 1;
    const nativeSpeed = Number.isFinite(Number(rawNativeSpeed)) ? Number(rawNativeSpeed) : 1;
    const instructions = resolveEffectiveTtsInstructions({
      model,
      requestInstructions: mergedSettings?.ttsInstructions,
      sharedDefaultInstructions: credResolved.adminRecord?.defaultInstructions,
    });

    const useSmartAudio = Boolean(
      data.useSmartAudio
      || (typeof data.settings === 'object'
        && data.settings !== null
        && 'useSmartAudio' in data.settings
        && Boolean((data.settings as Record<string, unknown>).useSmartAudio))
    );
    const smartAudioProfileId = typeof data.settings === 'object' && data.settings !== null && 'smartAudioProfileId' in data.settings
      ? String((data.settings as Record<string, unknown>).smartAudioProfileId || '')
      : '';
    const confirmScholarAutoScan = typeof data.settings === 'object'
      && data.settings !== null
      && (data.settings as Record<string, unknown>).scholarAutoScan === true;
    const profilesDocument = useSmartAudio
      ? await readSmartAudioProfilesDocument(storageUserId)
      : null;
    const selectedProfile = profilesDocument
      ? findSmartAudioProfileById(profilesDocument, smartAudioProfileId)
      : null;
    if (useSmartAudio && !selectedProfile) {
      return NextResponse.json(
        { error: 'The selected Smart Audio profile could not be loaded.' },
        { status: 400 },
      );
    }
    const isScholarLikeMode = isScholarLikeSmartAudioMode(selectedProfile?.workerMode);
    let multiVoiceCast: MultiVoiceCastMember[] = [];
    let cloudDramaCast: SmartAudioCharacterMap | null = null;
    if (selectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE || selectedProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
      const isCloudDrama = selectedProfile.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE;
      if (!isCloudDrama && !isKokoroModel(model)) {
        return NextResponse.json({
          code: 'MULTI_VOICE_KOKORO_REQUIRED',
          error: 'LitRPG Audio Drama currently requires a Kokoro TTS model.',
        }, { status: 409 });
      }
      const settingRows = await db.select({ dataJson: documentSettings.dataJson })
        .from(documentSettings)
        .where(and(
          eq(documentSettings.documentId, sourceDocumentId),
          eq(documentSettings.userId, storageUserId),
        ))
        .limit(1);
      let storedSettings: unknown = settingRows[0]?.dataJson || {};
      if (typeof storedSettings === 'string') {
        try { storedSettings = JSON.parse(storedSettings); } catch { storedSettings = {}; }
      }
      const resolvedSettings = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, storedSettings);
      const readiness = isCloudDrama
        ? getCloudTtsCharacterMapReadiness(
          storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings)
            ? (storedSettings as Record<string, unknown>).smartAudioCharacters
            : null,
        )
        : getCharacterMapReadiness(resolvedSettings.smartAudioCharacters);
      if (!readiness.ready || readiness.map?.profileId !== selectedProfile.id) {
        return NextResponse.json({
          code: 'CHARACTER_CAST_REQUIRED',
          error: isCloudDrama
            ? 'Review and assign the Google Cloud Drama character voices before cleaning this chapter.'
            : 'Review and assign the LitRPG character voices before cleaning this chapter.',
        }, { status: 409 });
      }
      if (isCloudDrama) cloudDramaCast = readiness.map;
      else multiVoiceCast = buildMultiVoiceCast(readiness.map);
    }
    let bookLexicon = isScholarLikeMode
      ? await readBookLexicon(storageUserId, sourceDocumentId)
      : null;
    const scholarScanIncomplete = isScholarLikeMode
      && (
        bookLexicon?.status !== 'complete'
        || bookLexicon.definitionScanComplete !== true
        || bookLexicon.profileId !== selectedProfile?.id
      );

    // This is a confirmation preflight, not a TTS attempt. Return it before
    // consuming any character quota so the confirmed retry is charged once.
    if (scholarScanIncomplete && !confirmScholarAutoScan) {
      return NextResponse.json({
        code: 'SCHOLAR_SCAN_REQUIRED',
        error: 'This book needs a pronunciation and definition scan before Scholar generation.',
      }, { status: 409 });
    }

    const ttsRateLimitEnabled = !runtimeConfig.disableTtsRateLimit;
    const limits = resolveRateLimitThresholds({
      anonymous: runtimeConfig.ttsDailyLimitAnonymous,
      authenticated: runtimeConfig.ttsDailyLimitAuthenticated,
      ipAnonymous: runtimeConfig.ttsIpDailyLimitAnonymous,
      ipAuthenticated: runtimeConfig.ttsIpDailyLimitAuthenticated,
    });

    if (ttsRateLimitEnabled) {
      const isAnonymous = Boolean(user?.isAnonymous);
      const charCount = data.text.length;
      const ip = getClientIp(request);
      const device = isAnonymous ? getOrCreateDeviceId(request) : null;
      if (device?.didCreate) {
        didCreateDeviceIdCookie = true;
        deviceIdToSet = device.deviceId;
      }

      const rateLimitResult = await rateLimiter.checkAndIncrementLimit(
        { id: storageUserId, isAnonymous },
        charCount,
        {
          deviceId: device?.deviceId ?? null,
          ip,
        },
        {
          enabled: ttsRateLimitEnabled,
          limits,
        },
      );

      if (!rateLimitResult.allowed) {
        const resetTimeMs = rateLimitResult.resetTimeMs;
        const retryAfterSeconds = Math.max(
          0,
          Math.ceil((resetTimeMs - Date.now()) / 1000),
        );

        const problem: ProblemDetails = {
          type: PROBLEM_TYPES.dailyQuotaExceeded,
          title: 'Daily quota exceeded',
          status: 429,
          detail: 'Daily character limit exceeded',
          code: 'USER_DAILY_QUOTA_EXCEEDED',
          currentCount: rateLimitResult.currentCount,
          limit: rateLimitResult.limit,
          remainingChars: rateLimitResult.remainingChars,
          resetTimeMs,
          userType: isAnonymous ? 'anonymous' : 'authenticated',
          upgradeHint: isAnonymous
            ? `Sign up to increase your limit from ${formatLimitForHint(limits.anonymous)} to ${formatLimitForHint(limits.authenticated)} characters per day`
            : undefined,
          instance: request.nextUrl.pathname,
        };

        const response = new NextResponse(JSON.stringify(problem), {
          status: 429,
          headers: {
            'Content-Type': 'application/problem+json',
            'Retry-After': String(retryAfterSeconds),
          },
        });

        attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
        return response;
      }
    }
// ==========================================
    // 🧠 BEGIN PYTHON/GEMINI INTERCEPTION
    // ==========================================
    let processedTextForTts = data.text;
    let smartAudioOmitted = false;

    // ONLY run the Python worker if the frontend toggle is switched ON
    if (useSmartAudio && profilesDocument) {
        const geminiApiKey = (selectedProfile?.geminiApiKey || '').trim();
        if (scholarScanIncomplete && confirmScholarAutoScan && selectedProfile) {
          const previousBookLexicon = bookLexicon?.profileId === selectedProfile.id
            ? bookLexicon
            : null;
          const knownPronunciations = filterKokoroCompatiblePronunciationRecord(
            selectedProfile.pronunciations || {},
          );
          {
            const globalRows = await db.select()
              .from(adminSettings)
              .where(eq(adminSettings.key, 'global_pronunciations'))
              .limit(1);
            if (globalRows[0]) {
              try {
                const globalLibrary = JSON.parse(globalRows[0].valueJson) as Record<string, unknown>;
                const globalCandidates: Record<string, string> = {};
                for (const [term, value] of Object.entries(globalLibrary)) {
                  const first = Array.isArray(value) ? value[0] : value;
                  const pronunciation = typeof first === 'string'
                    ? first
                    : first && typeof first === 'object' && 'phonetic' in first
                      ? String((first as { phonetic?: unknown }).phonetic || '')
                      : '';
                  if (pronunciation) {
                    globalCandidates[term] = pronunciation;
                  }
                }
                const compatibleGlobalPronunciations =
                  filterKokoroCompatiblePronunciationRecord(globalCandidates);
                for (const [term, pronunciation] of Object.entries(compatibleGlobalPronunciations)) {
                  if (!knownPronunciations[term]) {
                    knownPronunciations[term] = pronunciation;
                  }
                }
              } catch {
                // A malformed optional global library must not hide the explicit
                // Scholar auto-scan path; Gemini can resolve the affected terms.
              }
            }
          }
          bookLexicon = await resolveSmartAudioBookLexicon({
            profile: selectedProfile,
            candidates: collectSmartAudioTermCandidates(
              [data.text],
              knownPronunciations,
              await readGlobalDefinitions(),
            ),
            existing: previousBookLexicon,
            onUsage: (usage) => {
              serverLogger.info({
                event: 'audiobook.chapter.smart_audio.lexicon.usage',
                bookId,
                sourceDocumentId,
                model: usage.model,
                batch: usage.batch,
                ...usage.tokens,
              }, 'Gemini Scholar lexicon usage');
            },
          });
          await writeBookLexicon(storageUserId, sourceDocumentId, {
            ...bookLexicon,
            status: 'partial',
            definitionScanComplete: false,
            entries: {
              ...(previousBookLexicon?.entries || {}),
              ...bookLexicon.entries,
            },
          });
        }
        let smartAudioConnection: Awaited<ReturnType<typeof connect>> | null = null;
        try {
          serverLogger.info(
            { event: 'audiobook.chapter.smart_audio.enabled', bookId, smartAudioProfileId: selectedProfile?.id },
            'Smart Audio Toggle is ON. Triggering Python Gemini worker...'
          );
          const natsUrl = process.env.NATS_URL || "nats://127.0.0.1:4222";
          smartAudioConnection = await connect({ servers: natsUrl });
          const nc = smartAudioConnection;
          const sc = StringCodec();
          
          let finalPronunciations = filterKokoroCompatiblePronunciationRecord(
            selectedProfile?.pronunciations || {},
          );
          {
            const globalSettingsRow = await db.select().from(adminSettings).where(eq(adminSettings.key, 'global_pronunciations')).limit(1);
            if (globalSettingsRow && globalSettingsRow.length > 0) {
              try {
                const globalPronunciations = JSON.parse(globalSettingsRow[0].valueJson);
                const resolvedGlobal: Record<string, string> = {};
                for (const [key, val] of Object.entries(globalPronunciations)) {
                  if (Array.isArray(val) && val.length > 0) {
                    const first = val[0];
                    if (typeof first === 'string') {
                      resolvedGlobal[key] = first;
                    } else if (first && typeof first === 'object' && typeof first.phonetic === 'string') {
                      resolvedGlobal[key] = first.phonetic;
                    }
                  } else if (typeof val === 'string') {
                    resolvedGlobal[key] = val;
                  }
                }
                finalPronunciations = filterKokoroCompatiblePronunciationRecord({
                  ...resolvedGlobal,
                  ...finalPronunciations,
                }); // Profile overrides global
              } catch {
                // Ignore parse errors
              }
            }
          }
          finalPronunciations = filterKokoroCompatiblePronunciationRecord({
            ...pronunciationsFromBookLexicon(bookLexicon),
            ...finalPronunciations,
          });

          const enrichedText = enrichTextFromBookLexicon(
            data.text,
            bookLexicon,
            {
              includeDefinitions: isScholarLikeMode,
              pronunciationOverrides: finalPronunciations,
            },
          );
          const authoritativePronunciations = finalPronunciations;
          finalPronunciations = selectPronunciationsForText(enrichedText, authoritativePronunciations);

          const payload = JSON.stringify(selectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE
            ? {
              user_id: storageUserId,
              api_key: geminiApiKey,
              backup_api_key: (selectedProfile.backupGeminiApiKey || '').trim(),
              ai_model: resolveCleanupAiModel(selectedProfile),
              ai_model_fallbacks: resolveCleanupAiModels(selectedProfile).slice(1),
              raw_text: enrichedText,
              characters: multiVoiceCast,
              continuity_state: 'Beginning of selected chapter.',
              pronunciation_prompt: buildKokoroPronunciationInstructions(selectedProfile),
              final_cleanup_rules: FINAL_SMART_AUDIO_PRONUNCIATION_CHECK,
              pronunciations: finalPronunciations,
            }
            : {
              user_id: storageUserId,
              api_key: geminiApiKey,
              ai_model: resolveCleanupAiModel(selectedProfile),
              ai_model_fallbacks: resolveCleanupAiModels(selectedProfile).slice(1),
              prompt: buildSmartAudioCleanupPrompt(selectedProfile?.customTtsPrompt),
              final_cleanup_rules: FINAL_SMART_AUDIO_PRONUNCIATION_CHECK,
              pronunciation_prompt: buildKokoroPronunciationInstructions(selectedProfile),
              raw_text: enrichedText,
              pronunciations: finalPronunciations,
              abbreviations: selectedProfile?.abbreviations || {},
              books: selectedProfile?.books || {},
            });

          const SCHOLAR_NATS_SUBJECT = 'audiobooks.scholar.clean';
          const targetSubject = selectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE
            ? 'audiobooks.multivoice.assign'
            : isScholarLikeMode
              ? SCHOLAR_NATS_SUBJECT
              : SMART_AUDIO_NATS_SUBJECT;
          const msg = await nc.request(targetSubject, sc.encode(payload), {
            timeout: resolveSmartAudioNatsTimeoutMs(selectedProfile?.workerMode),
          });
          const applyAuthoritativeBookTags = (value: unknown): unknown => {
            if (
              selectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE
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
                pronunciationOverrides: authoritativePronunciations,
              }),
            };
          };
          let workerResult = applyAuthoritativeBookTags(JSON.parse(sc.decode(msg.data))) as Record<string, unknown>;

          if (workerResult.status === "success") {
            const recovery = await resolveSmartAudioWithValidationRecovery({
              initialResult: workerResult,
              targetedRepair: selectedProfile ? candidate => repairSmartAudioWorkerPronunciations(candidate, {
                profile: selectedProfile, sourceText: data.text, dictionary: authoritativePronunciations, signal: request.signal,
              }) : undefined,
              authoritativePronunciations,
              onUnrecoverable: async (rejected, errors) => {
                await savePronunciationFailure({ bookId, userId: storageUserId, chapterIndex, chapterTitle: `Chapter ${chapterIndex + 1}`,
                  sourceText: data.text, rejected, errors: errors.slice(0, 1), profileId: selectedProfile?.id,
                  cast: multiVoiceCast, namespace: testNamespace,
                }).catch(() => serverLogger.warn({ event: 'audiobook.pronunciation_failure.save_failed', bookId, chapter: chapterIndex }, 'Could not retain rejected chapter for pronunciation review.'));
              },
              resolve: (candidate) => {
                const multiVoiceResult = selectedProfile?.workerMode === MULTI_VOICE_WORKER_MODE
                  ? resolveMultiVoiceWorkerResult(candidate, multiVoiceCast, {
                    authoritativePronunciations,
                  })
                  : null;
                const resolvedWorkerResult = multiVoiceResult
                  ? { outcome: 'cleaned' as const, text: multiVoiceResult.taggedText }
                  : resolveSmartAudioWorkerResult(candidate, {
                    authoritativePronunciations,
                    sourceText: data.text,
                    requirePronunciationTagsForForeignScripts: isScholarLikeSmartAudioMode(selectedProfile?.workerMode),
                  });
                return { multiVoiceResult, resolvedWorkerResult };
              },
              requestRepair: async (rejectedResult, validationError) => {
                const requestedModel = resolveCleanupAiModel(selectedProfile);
                const repairModel = resolveSmartAudioValidationRepairModel(requestedModel);
                serverLogger.warn({
                  event: 'audiobook.chapter.smart_audio.validation_repair',
                  bookId,
                  chapter: chapterIndex,
                  requestedModel,
                  repairModel,
                  error: errorToLog(validationError),
                }, 'Smart Audio output failed validation; requesting one correction with the quality-repair model.');
                const repairMessage = await nc.request(
                  targetSubject,
                  sc.encode(buildSmartAudioValidationRepairPayload(
                    payload,
                    rejectedResult,
                    validationError,
                  )),
                  { timeout: resolveSmartAudioNatsTimeoutMs(selectedProfile?.workerMode) },
                );
                return applyAuthoritativeBookTags(JSON.parse(sc.decode(repairMessage.data)));
              },
              sourceFallback: (rejectedResult) => ({
                ...(rejectedResult && typeof rejectedResult === 'object' && !Array.isArray(rejectedResult)
                  ? rejectedResult as Record<string, unknown>
                  : {}),
                status: 'success',
                outcome: 'cleaned',
                cleaned_text: extractNarratableSmartAudioSourceText(data.text),
                changelog: 'Smart Audio repeatedly omitted substantial source text; OpenReader preserved the original narratable text.',
                source_fallback: true,
              }),
            });
            workerResult = recovery.workerResult;
            const { resolvedWorkerResult } = recovery.result;
            if (recovery.sourceFallbackUsed) {
              serverLogger.warn({
                event: 'audiobook.chapter.smart_audio.source_fallback',
                bookId,
                chapter: chapterIndex,
                validationErrors: recovery.validationErrors,
              }, 'Smart Audio repeatedly omitted substantial source text; continuing with the original narratable text.');
            } else if (recovery.fallbackUsed) {
              serverLogger.warn({
                event: 'audiobook.chapter.smart_audio.pronunciation_fallback',
                bookId,
                chapter: chapterIndex,
                discardedTags: recovery.discardedTags,
                validationErrors: recovery.validationErrors,
              }, 'Discarded unsafe pronunciation markup after the correction pass; continuing with cleaned text.');
            }
            processedTextForTts = resolvedWorkerResult.text;
            smartAudioOmitted = resolvedWorkerResult.outcome === 'omitted';
            serverLogger.info(
              {
                event: 'audiobook.chapter.smart_audio.cleaned',
                bookId,
                chapter: chapterIndex,
                requestedModel: resolveCleanupAiModel(selectedProfile),
                model: typeof workerResult.model_used === 'string'
                  ? workerResult.model_used
                  : resolveCleanupAiModel(selectedProfile),
                pass: 'cleanup',
                worker_mode: selectedProfile?.workerMode || 'standard',
                nats_subject: targetSubject,
                definition_pass_ran: false,
                definitions_found: Object.values(bookLexicon?.entries || {})
                  .filter((entry) => Boolean(entry.definition)).length,
                toc_sections_skipped: 0,
                tokens: normalizeGeminiTokenUsage(workerResult.usage),
              },
              'Python worker cleaned the chapter text.'
            );

            // Save the changelog for UI viewing
            if (typeof workerResult.changelog === 'string' && workerResult.changelog) {
              const changelogName = `${String(chapterIndex + 1).padStart(4, '0')}__changelog.txt`;
              await putAudiobookObject(
                bookId,
                storageUserId,
                changelogName,
                Buffer.from(workerResult.changelog, 'utf8'),
                'text/plain; charset=utf-8',
                testNamespace,
              ).catch((e) => {
                serverLogger.warn({ event: 'audiobook.chapter.smart_audio.changelog_failed', error: errorToLog(e) }, 'Failed to save changelog');
              });
            }

          } else {
            throw new Error(`Python worker returned error: ${workerResult.message || workerResult.status || 'unknown response'}`);
          }
        } catch (natsError) {
          serverLogger.error(
            { event: 'audiobook.chapter.smart_audio.nats_failed', bookId, error: errorToLog(natsError) },
            'Smart Audio cleanup failed. Refusing to synthesize uncleaned text.'
          );
          throw new Error('Smart Audio cleanup failed; no audio was generated.', { cause: natsError });
        } finally {
          if (smartAudioConnection) {
            await smartAudioConnection.close().catch(() => {});
          }
        }
    } else {
        serverLogger.info(
          { event: 'audiobook.chapter.smart_audio.disabled', bookId },
          'Smart Audio Toggle is OFF. Using raw text.'
        );
    }
    // ==========================================
    // END PYTHON/GEMINI INTERCEPTION
    // ==========================================

    if (smartAudioOmitted) {
      const chapterPrefix = `${String(chapterIndex + 1).padStart(4, '0')}__`;
      for (const fileName of objectNames) {
        if (!fileName.startsWith(chapterPrefix)) continue;
        await deleteAudiobookObject(bookId, storageUserId, fileName, testNamespace).catch(() => {});
      }
      await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3', testNamespace).catch(() => {});
      await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b', testNamespace).catch(() => {});
      await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3.manifest.json', testNamespace).catch(() => {});
      await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b.manifest.json', testNamespace).catch(() => {});
      await db
        .delete(audiobookChapters)
        .where(and(
          eq(audiobookChapters.bookId, bookId),
          eq(audiobookChapters.userId, storageUserId),
          eq(audiobookChapters.chapterIndex, chapterIndex),
        ));

      const response = NextResponse.json({
        index: chapterIndex,
        title: data.chapterTitle,
        duration: 0,
        status: 'completed' as const,
        bookId,
        format,
        isEmptyText: true,
      });
      attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
      return response;
    }

    processedTextForTts = validateSmartAudioOutput(processedTextForTts, {
      requirePronunciationTagsForForeignScripts: isScholarLikeSmartAudioMode(selectedProfile?.workerMode),
    });

    const ttsBuffer = cloudDramaCast && selectedProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE
      ? await (async () => {
        try {
          const drama = await generateCloudDramaAudiobook({
            cleanedText: processedTextForTts,
            characterMap: cloudDramaCast,
            geminiApiKey: selectedProfile.geminiApiKey || '',
            backupGeminiApiKey: selectedProfile.backupGeminiApiKey,
            directorModel: resolveCleanupAiModel(selectedProfile),
            serviceAccountJson: selectedProfile.googleCloudServiceAccountJson,
            dramaGeminiTtsSettings: selectedProfile.dramaGeminiTtsSettings,
            signal: request.signal,
          });
          await persistCloudDramaReviewFlags({ documentId: sourceDocumentId, userId: storageUserId, chapterIndex, flags: drama.reviewFlags });
          return drama.audioBuffer;
        } catch (error) {
          if (error instanceof CloudDramaGenerationError) {
            await persistCloudDramaReviewFlags({ documentId: sourceDocumentId, userId: storageUserId, chapterIndex, flags: error.reviewFlags });
          }
          throw error;
        }
      })()
      : await generateSegmentedAudiobookTtsBuffer(
      {
        text: processedTextForTts, // <--- CHANGED THIS FROM data.text
        voice,
        speed: nativeSpeed,
        format: 'mp3',
        model,
        instructions,
        language: mergedSettings?.language,
        provider,
        apiKey: openApiKey,
        baseUrl: openApiBaseUrl,
        testNamespace,
      },
      request.signal,
      {
        ttsCacheMaxSizeBytes: runtimeConfig.ttsCacheMaxSizeBytes,
        ttsCacheTtlMs: runtimeConfig.ttsCacheTtlMs,
        ttsUpstreamMaxRetries: runtimeConfig.ttsUpstreamMaxRetries,
        ttsUpstreamTimeoutMs: runtimeConfig.ttsUpstreamTimeoutMs,
      },
    );

    workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-'));
    const inputPath = join(workDir, `${chapterIndex}-input.mp3`);
    const chapterOutputTempPath = join(workDir, `${chapterIndex}-chapter.tmp.${format}`);
    const titleTag = encodeChapterTitleTag(chapterIndex, data.chapterTitle);

    await writeFile(inputPath, ttsBuffer);

    const canCopyMp3WithoutReencode = postSpeed === 1;
    if (canCopyMp3WithoutReencode) {
      try {
        await runFFmpeg(
          [
            '-y',
            '-i',
            inputPath,
            '-c:a',
            'copy',
            '-map_metadata',
            '-1',
            '-id3v2_version',
            '3',
            '-metadata',
            `title=${titleTag}`,
            '-f',
            'mp3',
            chapterOutputTempPath,
          ],
          request.signal,
        );
      } catch (copyError) {
        serverLogger.warn({
          event: 'audiobook.chapter.remux.failed',
          degraded: true,
          fallbackPath: 'mp3_reencode',
          error: errorToLog(copyError),
        }, 'Chapter remux failed; falling back to mp3 re-encode');
        await runFFmpeg(
          chapterEncodeArgs(inputPath, chapterOutputTempPath, format, postSpeed, titleTag),
          request.signal,
        );
      }
    } else {
      await runFFmpeg(
        chapterEncodeArgs(inputPath, chapterOutputTempPath, format, postSpeed, titleTag),
        request.signal,
      );
    }

    const probe = await ffprobeAudio(chapterOutputTempPath, request.signal);
    const duration = probe.durationSec ?? 0;

    const finalChapterName = encodeChapterFileName(chapterIndex, data.chapterTitle, format);
    const finalChapterBytes = await readFile(chapterOutputTempPath);
    await putAudiobookObject(bookId, storageUserId, finalChapterName, finalChapterBytes, chapterFileMimeType(format), testNamespace);

    // Save the edited text so it persists in the Review UI
    const textFileName = `${String(chapterIndex + 1).padStart(4, '0')}__text.txt`;
    await putAudiobookObject(
      bookId,
      storageUserId,
      textFileName,
      Buffer.from(processedTextForTts, 'utf8'),
      'text/plain; charset=utf-8',
      testNamespace
    );

    const chapterPrefix = `${String(chapterIndex + 1).padStart(4, '0')}__`;
    for (const fileName of objectNames) {
      if (!fileName.startsWith(chapterPrefix)) continue;
      if (!fileName.endsWith('.mp3') && !fileName.endsWith('.m4b')) continue;
      if (fileName === finalChapterName) continue;
      await deleteAudiobookObject(bookId, storageUserId, fileName, testNamespace).catch(() => {});
    }

    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3.manifest.json', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b.manifest.json', testNamespace).catch(() => {});
    await Promise.all([
      deleteAudiobookObject(bookId, storageUserId, `${chapterPrefix}rejected.txt`, testNamespace).catch(() => {}),
      deleteAudiobookObject(bookId, storageUserId, `${chapterPrefix}pronunciation_failure.json`, testNamespace).catch(() => {}),
    ]);

    if (!normalizedExistingSettings && incomingSettings) {
      const settingsToPersist: AudiobookGenerationSettings = {
        ...incomingSettings,
        providerRef: effectiveProviderRef,
        providerType: provider,
        ttsModel: model,
        ...(resolveTtsProviderModelPolicy({
          providerRef: effectiveProviderRef,
          providerType: provider,
          model,
        }).supportsInstructions
          ? { ttsInstructions: instructions ?? '' }
          : { ttsInstructions: '' }),
      };
      await putAudiobookObject(
        bookId,
        storageUserId,
        'audiobook.meta.json',
        Buffer.from(JSON.stringify(settingsToPersist, null, 2), 'utf8'),
        'application/json; charset=utf-8',
        testNamespace,
      );
    }

    await db
      .insert(audiobookChapters)
      .values({
        id: `${bookId}-${chapterIndex}`,
        bookId,
        userId: storageUserId,
        chapterIndex,
        title: data.chapterTitle,
        duration,
        format,
        filePath: finalChapterName,
      })
      .onConflictDoUpdate({
        target: [audiobookChapters.id, audiobookChapters.userId],
        set: { title: data.chapterTitle, duration, format, filePath: finalChapterName },
      });

    const response = NextResponse.json({
      index: chapterIndex,
      title: data.chapterTitle,
      duration,
      status: 'completed' as const,
      bookId,
      format,
    });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  } catch (error) {
    if ((error as Error)?.message === 'ABORTED' || (error as Error)?.name === 'AbortError' || request.signal.aborted) {
      const response = NextResponse.json({ error: 'cancelled' }, { status: 499 });
      attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
      return response;
    }

    const upstreamStatus = getUpstreamStatus(error);
    if (upstreamStatus === 429) {
      const retryAfterSeconds = getUpstreamRetryAfterSeconds(error);
      const problem: ProblemDetails = {
        type: PROBLEM_TYPES.upstreamRateLimited,
        title: 'Upstream rate limited',
        status: 429,
        detail: retryAfterSeconds
          ? `The TTS provider is rate limiting requests. Please retry in about ${retryAfterSeconds}s.`
          : 'The TTS provider is rate limiting requests. Please try again shortly.',
        code: 'UPSTREAM_RATE_LIMIT',
        provider: providerForError ?? undefined,
        upstreamStatus,
        retryAfterSeconds,
        instance: request.nextUrl.pathname,
      };

      const response = new NextResponse(JSON.stringify(problem), {
        status: 429,
        headers: {
          'Content-Type': 'application/problem+json',
          ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
        },
      });

      attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
      return response;
    }

    serverLogger.error({
      event: 'audiobook.chapter.process.failed',
      error: errorToLog(error),
    }, 'Failed to process audio chapter');
    const response = errorResponse(error, {
      apiErrorMessage: 'Failed to process audio chapter',
      normalize: { code: 'AUDIOBOOK_CHAPTER_PROCESS_FAILED', errorClass: 'upstream' },
    });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function GET(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    const chapterIndexStr = request.nextUrl.searchParams.get('chapterIndex');

    if (!bookId || !chapterIndexStr) {
      return NextResponse.json({ error: 'Missing bookId or chapterIndex parameter' }, { status: 400 });
    }

    const chapterIndex = Number.parseInt(chapterIndexStr, 10);
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      return NextResponse.json({ error: 'Invalid chapterIndex parameter' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const storageUserId = ctxOrRes.userId;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const existingBookRows = await db
      .select({ userId: audiobooks.userId })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));

    if (existingBookRows.length === 0) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const chapter = findChapterFileNameByIndex(
      objects.map((object) => object.fileName),
      chapterIndex,
    );

    if (!chapter) {
      await db
        .delete(audiobookChapters)
        .where(
          and(
            eq(audiobookChapters.bookId, bookId),
            eq(audiobookChapters.userId, storageUserId),
            eq(audiobookChapters.chapterIndex, chapterIndex),
          ),
        );
      return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
    }

    let buffer: Buffer;
    try {
      buffer = await getAudiobookObjectBuffer(bookId, storageUserId, chapter.fileName, testNamespace);
    } catch (error) {
      if (isMissingBlobError(error)) {
        await db
          .delete(audiobookChapters)
          .where(
            and(
              eq(audiobookChapters.bookId, bookId),
              eq(audiobookChapters.userId, storageUserId),
              eq(audiobookChapters.chapterIndex, chapterIndex),
            ),
          );
        return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
      }
      throw error;
    }

    const mimeType = chapter.format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
    
    // Support seeking (Range requests) for HTML5 audio players
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : buffer.length - 1;
      const chunksize = (end - start) + 1;
      
      const chunk = buffer.subarray(start, end + 1);
      
      return new NextResponse(chunk as any, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize.toString(),
          'Content-Type': mimeType,
          'Content-Disposition': contentDispositionAttachment(`${chapter.title}.${chapter.format}`),
          'Cache-Control': 'no-cache',
        },
      });
    }

    return new NextResponse(streamBuffer(buffer), {
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Length': buffer.length.toString(),
        'Content-Type': mimeType,
        'Content-Disposition': contentDispositionAttachment(`${chapter.title}.${chapter.format}`),
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    serverLogger.error({
      event: 'audiobook.chapter.download.failed',
      error: errorToLog(error),
    }, 'Failed to download chapter');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to download chapter',
      normalize: { code: 'AUDIOBOOK_CHAPTER_DOWNLOAD_FAILED', errorClass: 'storage' },
    });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    const chapterIndexStr = request.nextUrl.searchParams.get('chapterIndex');

    if (!bookId || !chapterIndexStr) {
      return NextResponse.json({ error: 'Missing bookId or chapterIndex parameter' }, { status: 400 });
    }

    const chapterIndex = Number.parseInt(chapterIndexStr, 10);
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      return NextResponse.json({ error: 'Invalid chapterIndex parameter' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const storageUserId = ctxOrRes.userId;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const existingBookRows = await db
      .select({ userId: audiobooks.userId })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));

    if (existingBookRows.length === 0) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    await db
      .delete(audiobookChapters)
      .where(
        and(
          eq(audiobookChapters.bookId, bookId),
          eq(audiobookChapters.userId, storageUserId),
          eq(audiobookChapters.chapterIndex, chapterIndex),
        ),
      );

    const objectNames = (await listAudiobookObjects(bookId, storageUserId, testNamespace)).map((object) => object.fileName);
    const chapterPrefix = `${String(chapterIndex + 1).padStart(4, '0')}__`;

    for (const fileName of objectNames) {
      if (!fileName.startsWith(chapterPrefix)) continue;
      if (!fileName.endsWith('.mp3') && !fileName.endsWith('.m4b')) continue;
      await deleteAudiobookObject(bookId, storageUserId, fileName, testNamespace).catch(() => {});
    }

    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3.manifest.json', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b.manifest.json', testNamespace).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    serverLogger.error({
      event: 'audiobook.chapter.delete.failed',
      error: errorToLog(error),
    }, 'Failed to delete chapter');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to delete chapter',
      normalize: { code: 'AUDIOBOOK_CHAPTER_DELETE_FAILED', errorClass: 'db' },
    });
  }
}
