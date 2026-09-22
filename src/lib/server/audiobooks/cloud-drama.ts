import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { directDramaWithGemini } from '@/lib/server/smart-audio/drama-director';
import { synthesizeDramaSegment } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import type { DramaSynthesisReviewFlag } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { getCloudTtsCharacterMapReadiness } from '@/lib/server/smart-audio/google-cloud-cast-helpers';
import { splitDramaTextByUtf8 } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { concatenateMp3Segments, generateSilentMp3Segment } from './segmented-tts';

export interface CloudDramaAudiobookResult {
  audioBuffer: Buffer;
  reviewFlags: DramaSynthesisReviewFlag[];
}

/** Direct and synthesize a cleaned chapter while preserving failed lines for review. */
export async function generateCloudDramaAudiobook(input: {
  cleanedText: string;
  characterMap: SmartAudioCharacterMap;
  geminiApiKey: string;
  backupGeminiApiKey?: string;
  directorModel: string;
  serviceAccountJson?: string;
  signal?: AbortSignal;
}): Promise<CloudDramaAudiobookResult> {
  const readiness = getCloudTtsCharacterMapReadiness(input.characterMap);
  if (!readiness.ready || !readiness.map) throw new Error('Cloud Drama cast is not ready.');
  if (!input.geminiApiKey.trim()) throw new Error('A Gemini API key is required for the Drama Director.');
  const audioSegments: Buffer[] = [];
  const reviewFlags: DramaSynthesisReviewFlag[] = [];
  const castNames = Object.keys(readiness.map.entries);
  const sourceBatches = splitDramaTextByUtf8(input.cleanedText, 12_000);
  let silentSegment: Buffer | null = null;

  for (const sourceText of sourceBatches) {
    if (input.signal?.aborted) throw new Error('ABORTED');
    const directed = await directDramaWithGemini({
      sourceText, castNames, apiKey: input.geminiApiKey,
      backupApiKey: input.backupGeminiApiKey,
      model: input.directorModel,
    });
    for (const segment of directed) {
      if (input.signal?.aborted) throw new Error('ABORTED');
      const result = await synthesizeDramaSegment({
        segment, characterMap: readiness.map,
        serviceAccountJson: input.serviceAccountJson,
      });
      reviewFlags.push(...result.reviewFlags);
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
