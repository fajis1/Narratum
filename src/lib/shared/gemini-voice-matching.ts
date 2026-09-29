import type { GeminiVoiceCatalogEntry } from './gemini-voice-catalog';
import type { SmartAudioCharacterEntry } from '@/types/document-settings';

export interface GeminiVoiceRecommendation {
  voice: GeminiVoiceCatalogEntry;
  score: number;
  reasons: string[];
  alreadyInUse: boolean;
}

export interface RecommendGeminiVoicesInput {
  character: Pick<SmartAudioCharacterEntry, 'name' | 'importance' | 'castingTraits' | 'description' | 'voiceAssignment'>;
  voices: readonly GeminiVoiceCatalogEntry[];
  usedVoiceIds?: ReadonlySet<string>;
  narratorVoiceId?: string | null;
  limit?: number;
}

function normalizedWords(...values: Array<string | null | undefined>): Set<string> {
  return new Set(values.flatMap((value) => (value ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []));
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const word of left) if (right.has(word)) count += 1;
  return count;
}

/**
 * Deterministic, explainable metadata ranking. It never restricts a manual
 * selection; callers can show any catalog voice and use this only for order.
 */
export function recommendGeminiVoices(input: RecommendGeminiVoicesInput): GeminiVoiceRecommendation[] {
  if (input.character.voiceAssignment?.assignmentSource === 'user') return [];
  const traits = input.character.castingTraits;
  const characterWords = normalizedWords(
    input.character.description,
    ...(traits?.temperament ?? []),
    ...(traits?.vocalTraits ?? []),
    traits?.accentHint,
  );
  const isNarrator = input.character.name.trim().toLowerCase() === 'narrator';
  const used = input.usedVoiceIds ?? new Set<string>();
  const ranked = input.voices.filter((voice) => voice.type === 'prebuilt').map((voice) => {
    let score = 0;
    const reasons: string[] = [];
    const alreadyInUse = used.has(voice.id);
    if (traits?.genderPresentation && traits.genderPresentation !== 'unknown') {
      if (voice.gender === traits.genderPresentation) { score += 40; reasons.push(`${voice.gender} presentation matched`); }
      else if (voice.gender === 'neutral') { score += 10; reasons.push('neutral presentation fallback'); }
    }
    if (traits?.pitchPreference && traits.pitchPreference !== 'unknown' && voice.pitch === traits.pitchPreference) {
      score += 20; reasons.push(`${voice.pitch} pitch matched`);
    }
    if (traits?.accentHint && voice.accent?.toLowerCase().includes(traits.accentHint.toLowerCase())) {
      score += 10; reasons.push('accent hint matched');
    }
    if (voice.context?.toLowerCase().includes('audiobook')) { score += 15; reasons.push('audiobook context'); }
    if (isNarrator && voice.persona?.toLowerCase().includes('narrator')) { score += 20; reasons.push('narrator persona'); }
    const metadataWords = normalizedWords(voice.description, voice.persona, voice.context, voice.accent);
    const keywordScore = Math.min(15, overlap(characterWords, metadataWords) * 3);
    if (keywordScore) { score += keywordScore; reasons.push('description traits matched'); }
    if (alreadyInUse) { score -= input.character.importance === 'main' || isNarrator ? 35 : 12; reasons.push('already assigned'); }
    if (!isNarrator && input.narratorVoiceId === voice.id) { score -= 45; reasons.push('same as narrator'); }
    return { voice, score, reasons, alreadyInUse };
  });
  return ranked
    .sort((left, right) => right.score - left.score || Number(left.alreadyInUse) - Number(right.alreadyInUse) || left.voice.displayName.localeCompare(right.voice.displayName))
    .slice(0, Math.max(1, input.limit ?? ranked.length));
}

/** Returns the next best option after an already suggested or selected voice. */
export function recommendAnotherGeminiVoice(input: RecommendGeminiVoicesInput, excludeVoiceIds: ReadonlySet<string>): GeminiVoiceRecommendation | null {
  return recommendGeminiVoices(input).find((candidate) => !excludeVoiceIds.has(candidate.voice.id)) ?? null;
}
