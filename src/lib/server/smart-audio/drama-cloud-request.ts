import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap, SmartAudioCharacterEntry } from '@/types/document-settings';
import { CLOUD_TTS_CHARACTER_VOICE_SET } from '@/lib/shared/google-cloud-tts-voices';
import {
  buildCloudTtsRequest, CLOUD_TTS_SAFE_PROMPT_BYTES, CloudTtsInputError,
  measureUtf8Bytes, stripDisallowedTags,
} from './google-cloud-tts-client';
import type { CloudTtsSynthesizeRequest, CloudTtsSynthesisOptions } from './google-cloud-tts-client';
import type { DramaDirectorPolicy } from '@/lib/shared/drama-profile-settings';

function resolveCastEntry(map: SmartAudioCharacterMap, speaker: string): SmartAudioCharacterEntry {
  let entry = map.entries[speaker];
  if (!entry) throw new CloudTtsInputError(`Speaker ${speaker} is not in the reviewed cast.`);
  if (entry.aliasFor) entry = map.entries[entry.aliasFor];
  if (!entry || !entry.voiceId || !CLOUD_TTS_CHARACTER_VOICE_SET.has(entry.voiceId)) {
    throw new CloudTtsInputError(`Speaker ${speaker} has no valid Cloud TTS voice.`);
  }
  return entry;
}

/** Stable character identity plus scene-specific acting directions. */
export function buildDramaDirectorsBrief(segment: DramaDirectorSegment, entry: SmartAudioCharacterEntry, policy?: DramaDirectorPolicy): string {
  const direction = entry.cloudDirection;
  const performance = segment.performance;
  const expressiveness = segment.utteranceType === 'narration'
    ? `Narrator expressiveness: ${policy?.narratorPerformance.expressiveness ?? 'moderate'}.`
    : `Character expressiveness: ${policy?.characterPerformance.expressiveness ?? 'expressive'}.`;
  return [
    `Perform this excerpt as ${entry.name}.`,
    ...(policy ? [
      `Performance policy: overall style ${policy.overallStyle}; ${expressiveness} character consistency ${policy.characterPerformance.consistency}; verified audio tags ${policy.tags.usage}; dramatic pauses ${policy.tags.pauseStyle}.`,
    ] : []),
    `Character identity: ${direction?.audioProfile || entry.description || 'Use the selected voice naturally and consistently.'}`,
    ...(direction?.defaultPerformance ? [
      `Character baseline: ${[
        direction.defaultPerformance.pace && `pace ${direction.defaultPerformance.pace}`,
        direction.defaultPerformance.energy && `energy ${direction.defaultPerformance.energy}`,
        direction.defaultPerformance.intensity && `intensity ${direction.defaultPerformance.intensity}`,
        direction.defaultPerformance.delivery?.length && `delivery ${direction.defaultPerformance.delivery.join(', ')}`,
      ].filter(Boolean).join('; ')}.`,
    ] : []),
    `Scene: ${segment.sceneContext}`,
    `Utterance: ${segment.utteranceType}.`,
    `Moment: ${performance.primaryEmotion}${performance.secondaryEmotions.length ? `, with ${performance.secondaryEmotions.join(', ')}` : ''}; social intent ${performance.socialIntent}.`,
    `Delivery: ${performance.delivery.join(', ') || 'natural'}; pace ${performance.pace}; energy ${performance.energy}; emotional intensity ${performance.intensity}.`,
    ...(performance.nuance ? [`Nuance: ${performance.nuance}`] : []),
    ...(performance.tags.length ? [`Localized cues to consider only where natural: ${performance.tags.join(', ')}.`] : []),
    'Speak the supplied text faithfully. Do not add words or sound effects.',
  ].join('\n');
}

function clipUtf8(value: string, limit: number): string {
  let result = '';
  for (const character of value) {
    if (measureUtf8Bytes(result + character) > limit) break;
    result += character;
  }
  return result;
}

function compactDramaDirectorsBrief(segment: DramaDirectorSegment, entry: SmartAudioCharacterEntry): string {
  const performance = segment.performance;
  return [
    `Perform as ${clipUtf8(entry.name, 120)} with a consistent voice.`,
    `Character identity: ${clipUtf8(entry.cloudDirection?.audioProfile || entry.description || '', 1_200)}`,
    `Scene: ${clipUtf8(segment.sceneContext, 600)}`,
    `Emotion: ${performance.primaryEmotion}; secondary: ${performance.secondaryEmotions.join(', ')}; social intent: ${performance.socialIntent}.`,
    `Delivery: ${performance.delivery.join(', ')}; pace: ${performance.pace}; energy: ${performance.energy}; intensity: ${performance.intensity}.`,
    ...(performance.nuance ? [`Nuance: ${clipUtf8(performance.nuance, 250)}`] : []),
    'Speak the supplied text exactly.',
  ].join('\n');
}

export interface DramaCloudRequest {
  request: CloudTtsSynthesizeRequest;
  synthesisOptions: CloudTtsSynthesisOptions;
  deferredTags: DramaDirectorSegment['performance']['tags'];
  promptCompacted: boolean;
}

/** Build one exact Cloud REST request. Stage 9 owns localized tag placement and splitting. */
export function buildDramaCloudTtsRequest(input: {
  segment: DramaDirectorSegment;
  characterMap: SmartAudioCharacterMap;
  languageCode?: string;
  policy?: DramaDirectorPolicy;
  modelName?: string;
}): DramaCloudRequest {
  const { segment } = input;
  if (segment.omit_from_audio) throw new CloudTtsInputError('An omitted segment cannot be synthesized.');
  const entry = resolveCastEntry(input.characterMap, segment.speaker);
  const { stripped } = stripDisallowedTags(segment.text);
  if (stripped.length) throw new CloudTtsInputError('Source text contains bracketed content that Cloud TTS would remove.');
  const fullPrompt = buildDramaDirectorsBrief(segment, entry, input.policy);
  const promptCompacted = measureUtf8Bytes(fullPrompt) > CLOUD_TTS_SAFE_PROMPT_BYTES;
  const stylePrompt = promptCompacted ? compactDramaDirectorsBrief(segment, entry) : fullPrompt;
  const synthesisOptions: CloudTtsSynthesisOptions = {
    text: segment.text,
    stylePrompt,
    voiceName: entry.voiceId!,
    languageCode: input.languageCode ?? 'en-US',
    modelName: input.modelName,
    ...(entry.cloudDirection?.technicalOverrides
      ? { technicalOverrides: entry.cloudDirection.technicalOverrides }
      : {}),
  };
  return {
    request: buildCloudTtsRequest(synthesisOptions),
    synthesisOptions,
    deferredTags: segment.performance.tags,
    promptCompacted,
  };
}
