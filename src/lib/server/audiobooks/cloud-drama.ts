import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { directDramaWithGemini } from '@/lib/server/smart-audio/drama-director';
import { synthesizeDramaSegment } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import type { DramaSynthesisReviewFlag } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { getCloudTtsCharacterMapReadiness } from '@/lib/server/smart-audio/google-cloud-cast-helpers';
import { splitDramaTextByUtf8 } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { concatenateMp3Segments, generateSilentMp3Segment } from './segmented-tts';
import { buildDramaDirectorPolicy, normalizeDramaGeminiTtsProfileSettings } from '@/lib/shared/drama-profile-settings';

export interface CloudDramaAudiobookResult {
  audioBuffer: Buffer;
  reviewFlags: DramaSynthesisReviewFlag[];
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
  serviceAccountJson?: string;
  dramaGeminiTtsSettings?: unknown;
  priorContinuityState?: string;
  signal?: AbortSignal;
  ttsModel?: string;
  ttsModelFallbacks?: readonly string[];
  onModelFallback?: (fromModel: string, toModel: string, reason: string) => void;
}): Promise<CloudDramaAudiobookResult> {
  const readiness = getCloudTtsCharacterMapReadiness(input.characterMap);
  if (!readiness.ready || !readiness.map) throw new Error('Cloud Drama cast is not ready.');
  if (!input.geminiApiKey.trim()) throw new Error('A Gemini API key is required for the Drama Director.');
  const audioSegments: Buffer[] = [];
  const reviewFlags: DramaSynthesisReviewFlag[] = [];
  const profileSettings = normalizeDramaGeminiTtsProfileSettings(input.dramaGeminiTtsSettings);
  const policy = buildDramaDirectorPolicy(profileSettings);
  const castNames = Object.keys(readiness.map.entries);
  const sourceBatches = splitDramaTextByUtf8(input.cleanedText, 12_000);
  let silentSegment: Buffer | null = null;
  let continuityState = input.priorContinuityState;

  for (const sourceText of sourceBatches) {
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
    for (const segment of directed) {
      if (input.signal?.aborted) throw new Error('ABORTED');
      const result = await synthesizeDramaSegment({
        segment, characterMap: readiness.map,
        serviceAccountJson: input.serviceAccountJson,
        languageCode: profileSettings.languageCode,
        policy,
        modelName: input.ttsModel,
        fallbackModels: input.ttsModelFallbacks,
        onModelFallback: input.onModelFallback,
      });
      reviewFlags.push(...result.reviewFlags);
      const failures = result.reviewFlags.filter((flag) => flag.kind === 'cloud-tts-failed');
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
          silentSegment ??= await generateSilentMp3Segment(input.signal);
          audioSegments.push(silentSegment);
        }
      }
    }
  }
  if (!audioSegments.length) throw new Error('Cloud Drama produced no audio segments.');
  return {
    audioBuffer: await concatenateMp3Segments(audioSegments, input.signal),
    reviewFlags,
  };
}
