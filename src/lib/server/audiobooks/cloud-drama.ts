import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { directDramaWithGemini } from '@/lib/server/smart-audio/drama-director';
import { splitDramaTextByUtf8, synthesizeGeminiDramaSegment } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import type { DramaSynthesisReviewFlag } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { getGeminiTtsCharacterMapReadiness } from '@/lib/server/smart-audio/gemini-cast-helpers';
import { concatenateWavSegmentsToMp3, generateSilentWavSegment } from './segmented-tts';
import { buildDramaDirectorPolicy, normalizeDramaGeminiTtsProfileSettings } from '@/lib/shared/drama-profile-settings';

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
  onSynthesisFailure?: (flags: readonly DramaSynthesisReviewFlag[]) => Promise<void>;
  onDirectedSegments?: (segments: readonly DramaDirectorSegment[], complete: boolean) => Promise<void>;
  directionOnly?: boolean;
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
  const policy = buildDramaDirectorPolicy(profileSettings);
  const castNames = Object.keys(readiness.map.entries);
  const sourceBatches = splitDramaTextByUtf8(input.cleanedText, 12_000);
  let silentSegment: Buffer | null = null;
  let continuityState = input.priorContinuityState;

  for (const [batchIndex, sourceText] of sourceBatches.entries()) {
    if (input.signal?.aborted) throw new Error('ABORTED');
    const directed = await directDramaWithGemini({
      sourceText, castNames, apiKey: input.geminiApiKey,
      backupApiKey: input.backupGeminiApiKey,
      model: input.directorModel,
      policy,
      priorContinuityState: continuityState,
      onRepair: (attempt) => reviewFlags.push({
        kind: 'director-validation-repair', speaker: 'Narrator', sourceText,
        chunkIndex: 0, attempts: attempt, reason: `Director output required validation repair ${attempt}.`,
      }),
    });
    continuityState = directed.at(-1)?.sceneContext || continuityState;
    segments.push(...directed);
    await input.onDirectedSegments?.(segments, batchIndex === sourceBatches.length - 1);
    if (input.directionOnly) continue;
    for (const segment of directed) {
      if (input.signal?.aborted) throw new Error('ABORTED');
      const speakerEntry = readiness.map?.entries[segment.speaker];
      const segmentModel = (speakerEntry?.ttsModel ?? input.ttsModel) as import('@/lib/server/smart-audio/gemini-tts-client').GeminiTtsModel | undefined;
      const result = await synthesizeGeminiDramaSegment({
        segment, characterMap: readiness.map,
        apiKey: input.geminiApiKey,
        policy,
        modelName: segmentModel,
        fallbackModels: input.ttsModelFallbacks as readonly import('@/lib/server/smart-audio/gemini-tts-client').GeminiTtsModel[] | undefined,
        signal: input.signal,
      });
      reviewFlags.push(...result.reviewFlags);
      const failures = result.reviewFlags.filter((flag) => flag.kind === 'cloud-tts-failed');
      if (failures.length) await input.onSynthesisFailure?.(reviewFlags.filter((flag) => flag.kind === 'cloud-tts-failed'));
      if (failures.length && profileSettings.failedSegmentBehavior === 'stop-job') {
        throw new CloudDramaGenerationError(
          `Cloud Drama stopped after ${failures.length} failed segment(s).`,
          reviewFlags,
        );
      }
      for (const chunk of result.chunks) {
        if (chunk.omitted) continue;
        if (chunk.audioBuffer) audioSegments.push(chunk.audioBuffer);
        else if (chunk.needsPlaceholder) {
          silentSegment ??= await generateSilentWavSegment(input.signal);
          audioSegments.push(silentSegment);
        }
      }
    }
  }
  if (input.directionOnly) return { audioBuffer: Buffer.alloc(0), reviewFlags, segments };
  if (!audioSegments.length) throw new Error('Cloud Drama produced no audio segments.');
  return {
    audioBuffer: await concatenateWavSegmentsToMp3(audioSegments, input.signal),
    reviewFlags,
    segments,
  };
}
