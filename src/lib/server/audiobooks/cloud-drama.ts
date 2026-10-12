import { createDramaSourceSpans, batchDramaSourceSpans } from '@/lib/server/smart-audio/drama-source-spans';
import { synthesizeWithGeminiTts, type GeminiTtsDiagnostic } from '@/lib/server/smart-audio/gemini-tts-client';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { directDramaWithGemini } from '@/lib/server/smart-audio/drama-director';
import { synthesizeGeminiDramaSegment } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import type { DramaSynthesisReviewFlag } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { getGeminiTtsCharacterMapReadiness } from '@/lib/server/smart-audio/gemini-cast-helpers';
import { concatenateWavSegmentsToMp3, generateSilentWavSegment } from './segmented-tts';
import { buildDramaDirectorPolicy, normalizeDramaGeminiTtsProfileSettings } from '@/lib/shared/drama-profile-settings';
import { applyDramaAudioEffect, inspectDramaWav } from './drama-audio-effects';
import { GeminiDramaQuotaTracker } from '@/lib/server/smart-audio/gemini-drama-quota';
import { validateSavedDramaReview } from './drama-speaker-review';
import type { DramaSpeakerReview } from '@/lib/shared/drama-speaker-review';
import { classifyDramaChapterTitles, dramaChapterTitleSegment, needsSeparateDramaChapterTitle } from '@/lib/shared/drama-chapter-titles';
import { resolveGeminiDramaVoiceEntry } from '@/lib/server/smart-audio/drama-cloud-request';

export interface CloudDramaAudiobookResult {
  audioBuffer: Buffer;
  reviewFlags: DramaSynthesisReviewFlag[];
  segments: DramaDirectorSegment[];
}

export class CloudDramaGenerationError extends Error {
  constructor(message: string, public readonly reviewFlags: readonly DramaSynthesisReviewFlag[]) {
    super(message);
    this.name = 'CloudDramaGenerationError';
  }
}

/** Direct and synthesize a cleaned chapter while preserving failed lines for review. */
export async function generateCloudDramaAudiobook(input: {
  cleanedText: string;
  chapterTitle?: string;
  deferProviderFailures?: boolean;
  characterMap: SmartAudioCharacterMap;
  geminiApiKey: string;
  backupGeminiApiKey?: string;
  directorModel: string;
  dramaGeminiTtsSettings?: unknown;
  priorContinuityState?: string;
  signal?: AbortSignal;
  ttsModel?: string;
  ttsModelFallbacks?: readonly string[];
  onModelFallback?: (fromModel: string, toModel: string, reason: string) => void;
  /** Caller-owned structured lifecycle logging; payloads contain no source text or credentials. */
  onLifecycle?: (event: string, fields?: Record<string, unknown>) => void;
  onSynthesisFailure?: (flags: readonly DramaSynthesisReviewFlag[]) => Promise<void>;
  onDirectedSegments?: (segments: readonly DramaDirectorSegment[], complete: boolean) => Promise<void>;
  onTtsAttempt?: (record: GeminiTtsDiagnostic & { segmentNumber: number; speaker: string }) => Promise<void>;
  directionOnly?: boolean;
  quotaTracker?: GeminiDramaQuotaTracker;
  savedReview?: DramaSpeakerReview | null;
  profileId?: string;
}): Promise<CloudDramaAudiobookResult> {
  const readiness = await getGeminiTtsCharacterMapReadiness({
    value: input.characterMap,
    apiKey: input.geminiApiKey,
  });
  if (!readiness.ready || !readiness.map) throw new Error('Gemini Drama cast is not ready.')
  if (!input.geminiApiKey.trim()) throw new Error('A Gemini API key is required for the Drama Director.');
  const audioSegments: Buffer[] = [];
  const segments: DramaDirectorSegment[] = [];
  const reviewFlags: DramaSynthesisReviewFlag[] = [];
  const profileSettings = normalizeDramaGeminiTtsProfileSettings(input.dramaGeminiTtsSettings);
  if (input.savedReview?.speechTypes) profileSettings.speechTypes = normalizeDramaGeminiTtsProfileSettings({ speechTypes: input.savedReview.speechTypes }).speechTypes;
  if (input.savedReview?.chapterTitles) profileSettings.chapterTitles = normalizeDramaGeminiTtsProfileSettings({ chapterTitles: input.savedReview.chapterTitles }).chapterTitles;
  const policy = buildDramaDirectorPolicy(profileSettings);
  const castNames = Object.keys(readiness.map.entries);
  const sourceBatches = batchDramaSourceSpans(createDramaSourceSpans(input.cleanedText));
  let silentSegment: Buffer | null = null;
  let continuityState = input.priorContinuityState;
  let segmentNumber = 0;
  let elapsedMs = 0;
  let timelineKnown = true;
  const quotaTracker = input.quotaTracker ?? new GeminiDramaQuotaTracker();
  const prepared = input.savedReview ? validateSavedDramaReview(input.savedReview, {
    sourceText: input.cleanedText, characterMap: readiness.map, profileId: input.profileId ?? '',
  }) : null;

  for (const [batchIndex, sourceSpans] of (prepared ? [sourceBatches.flat()] : sourceBatches).entries()) {
    const sourceText = sourceSpans.map((span) => span.text).join('');
    if (input.signal?.aborted) throw new Error('ABORTED');
    input.onLifecycle?.('director.start', { batchIndex, model: input.directorModel, sourceByteCount: Buffer.byteLength(sourceText, 'utf8'), sourceSpanCount: sourceSpans.length });
    const rawDirected = prepared ?? await directDramaWithGemini({
      sourceText, sourceSpans, batchIndex, signal: input.signal,
      onDiagnostic: (fields) => input.onLifecycle?.('director.diagnostic', fields),
      castNames, apiKey: input.geminiApiKey,
      backupApiKey: input.backupGeminiApiKey,
      model: input.directorModel,
      policy,
      priorContinuityState: continuityState,
      onRepair: (attempt, issues) => {
        input.onLifecycle?.('director.validation', { batchIndex, model: input.directorModel, attempt, issueCount: issues.length });
        reviewFlags.push({ kind: 'director-validation-repair', speaker: 'Narrator', sourceText,
          ...(timelineKnown ? { timestampMs: Math.round(elapsedMs) } : {}),
          chunkIndex: batchIndex, attempts: attempt, reason: `Director output required validation repair ${attempt}.` });
      },
    });
    const directed = input.savedReview?.reviewedAt ? rawDirected : classifyDramaChapterTitles(rawDirected, input.chapterTitle);
    input.onLifecycle?.('director.response', { batchIndex, model: input.directorModel, segmentCount: directed.length });
    continuityState = directed.at(-1)?.sceneContext || continuityState;
    segments.push(...directed);
    await input.onDirectedSegments?.(segments, !!prepared || batchIndex === sourceBatches.length - 1);
    if (input.directionOnly) continue;
    const title = batchIndex === 0 && profileSettings.chapterTitles.enabled && needsSeparateDramaChapterTitle(directed, input.chapterTitle)
      ? dramaChapterTitleSegment(input.chapterTitle) : null;
    for (const segment of title ? [title, ...directed] : directed) {
      if (input.signal?.aborted) throw new Error('ABORTED');
      segmentNumber += 1;
      if (segment.utteranceType === 'chapter-title' && !profileSettings.chapterTitles.enabled) continue;
      const voice = resolveGeminiDramaVoiceEntry(readiness.map, segment, policy).voiceId ?? undefined;
      const speakerEntry = readiness.map?.entries[segment.speaker];
      const segmentModel = (speakerEntry?.ttsModel ?? input.ttsModel) as import('@/lib/server/smart-audio/gemini-tts-client').GeminiTtsModel | undefined;
      input.onLifecycle?.('tts.segment.start', { segmentNumber, speaker: segment.speaker, voice, model: segmentModel });
      const result = await synthesizeGeminiDramaSegment({
        segment, characterMap: readiness.map,
        apiKey: input.geminiApiKey,
        backupApiKey: input.backupGeminiApiKey,
        synthesize: (options) => synthesizeWithGeminiTts({ ...options,
          onDiagnostic: input.onTtsAttempt ? (record) => input.onTtsAttempt!({ ...record, segmentNumber, speaker: segment.speaker }) : undefined,
        }),
        policy,
        modelName: segmentModel,
        fallbackModels: input.ttsModelFallbacks as readonly import('@/lib/server/smart-audio/gemini-tts-client').GeminiTtsModel[] | undefined,
        signal: input.signal,
        deferProviderFailures: input.deferProviderFailures,
        quotaTracker,
      });
      const locatedFlags = result.reviewFlags.map(flag => ({ ...flag, segmentNumber,
        ...(timelineKnown ? { timestampMs: Math.round(elapsedMs) } : {}),
      }));
      reviewFlags.push(...locatedFlags);
      const audioBytes = result.chunks.reduce((total, chunk) => total + (chunk.audioBuffer?.length || 0), 0);
      const failed = result.reviewFlags.some((flag) => flag.kind === 'cloud-tts-failed');
      input.onLifecycle?.(failed ? 'tts.segment.failure' : 'tts.segment.success', {
        segmentNumber, speaker: segment.speaker, voice, model: segmentModel,
        chunkCount: result.chunks.length, audioBytes,
      });
      const failures = result.reviewFlags.filter((flag) => flag.kind === 'cloud-tts-failed');
      for (const [chunkIndex, chunk] of result.chunks.entries()) {
        for (const flag of locatedFlags.filter(flag => flag.chunkIndex === chunkIndex)) {
          if (timelineKnown) flag.timestampMs = Math.round(elapsedMs);
          else delete flag.timestampMs;
        }
        if (chunk.omitted) continue;
        let audio: Buffer | null = null;
        if (chunk.audioBuffer) audio = await applyDramaAudioEffect(chunk.audioBuffer, profileSettings.speechTypes[segment.utteranceType], input.signal);
        else if (chunk.needsPlaceholder && profileSettings.failedSegmentBehavior !== 'stop-job') {
          silentSegment ??= await generateSilentWavSegment(input.signal);
          audio = silentSegment;
        }
        if (audio) {
          audioSegments.push(audio);
          const wav = inspectDramaWav(audio);
          if (wav) elapsedMs += wav.durationMs;
          else timelineKnown = false;
        }
      }
      if (failures.length) await input.onSynthesisFailure?.(reviewFlags.filter((flag) => flag.kind === 'cloud-tts-failed'));
      if (failures.length && profileSettings.failedSegmentBehavior === 'stop-job') {
        throw new CloudDramaGenerationError(
          `Cloud Drama stopped after ${failures.length} failed segment(s).`,
          reviewFlags,
        );
      }
    }
  }
  if (input.directionOnly) return { audioBuffer: Buffer.alloc(0), reviewFlags, segments };
  // A title-only source chunk remains at its pinned index when titles are off.
  // Preserve it as brief silence rather than reporting a failed recording.
  if (!audioSegments.length && !profileSettings.chapterTitles.enabled && segments.some(segment => segment.utteranceType === 'chapter-title')
    && segments.every(segment => !segment.text.trim() || segment.utteranceType === 'chapter-title')) {
    audioSegments.push(await generateSilentWavSegment(input.signal));
  }
  if (!audioSegments.length) throw new Error('Cloud Drama produced no audio segments.');
  input.onLifecycle?.('chapter.audio_aggregation.start', { audioSegmentCount: audioSegments.length });
  const audioBuffer = await concatenateWavSegmentsToMp3(audioSegments, input.signal);
  input.onLifecycle?.('chapter.audio_aggregation.success', { audioSegmentCount: audioSegments.length, audioBytes: audioBuffer.length });
  return {
    audioBuffer,
    reviewFlags,
    segments,
  };
}
