import type { GeminiVoiceCatalogEntry } from './gemini-voice-catalog';
import type { SmartAudioCharacterEntry, SmartAudioCharacterMap } from '@/types/document-settings';
import { getCharacterMapReadiness } from './multi-voice';

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


export interface AutoAssignGeminiMinorVoicesInput {
  characterMap: SmartAudioCharacterMap;
  voices: readonly GeminiVoiceCatalogEntry[];
  targetCharacters?: readonly string[];
  assignedAt?: number;
}

export interface AutoAssignGeminiMinorVoicesResult {
  updatedMap: SmartAudioCharacterMap;
  assigned: Array<{ characterName: string; voiceId: string; reason: string }>;
  protectedVoices: string[];
}

function catalogSnapshot(voice: GeminiVoiceCatalogEntry): NonNullable<SmartAudioCharacterEntry['voiceAssignment']>['catalogSnapshot'] {
  return {
    displayName: voice.displayName,
    ...(voice.languageCode ? { languageCode: voice.languageCode } : {}),
    ...(voice.accent ? { accent: voice.accent } : {}),
    gender: voice.gender,
    pitch: voice.pitch,
    ...(voice.persona ? { persona: voice.persona } : {}),
    ...(voice.context ? { context: voice.context } : {}),
    ...(voice.description ? { description: voice.description } : {}),
  };
}

/**
 * Deterministically assigns only presently-unassigned minor roles from the
 * live Gemini catalog. Existing manual/main assignments always win.
 */
export function autoAssignGeminiMinorVoices(
  input: AutoAssignGeminiMinorVoicesInput,
): AutoAssignGeminiMinorVoicesResult {
  const catalog = input.voices.filter((voice) => voice.type === 'prebuilt');
  const validVoiceSet = new Set(catalog.map((voice) => voice.id));
  const entries = Object.fromEntries(
    Object.entries(input.characterMap.entries).map(([name, entry]) => [name, { ...entry }]),
  );
  const targetNames = input.targetCharacters
    ? new Set(input.targetCharacters.map((name) => name.toLocaleLowerCase()))
    : null;
  const narrator = Object.values(entries).find((entry) => !entry.aliasFor && entry.name.toLocaleLowerCase() === 'narrator');
  const narratorVoiceId = narrator?.voiceId ?? null;
  const usedVoiceIds = new Set(
    Object.values(entries)
      .filter((entry) => !entry.aliasFor && entry.voiceId && validVoiceSet.has(entry.voiceId))
      .map((entry) => entry.voiceId as string),
  );
  const protectedVoices = new Set<string>();
  for (const entry of Object.values(entries)) {
    if (entry.aliasFor || !entry.voiceId || !validVoiceSet.has(entry.voiceId)) continue;
    if (entry.name.toLocaleLowerCase() === 'narrator' || entry.importance === 'main' || entry.voiceAssignment?.assignmentSource === 'user') {
      protectedVoices.add(entry.voiceId);
    }
  }

  const assigned: Array<{ characterName: string; voiceId: string; reason: string }> = [];
  for (const entry of Object.values(entries)) {
    if (entry.aliasFor || entry.name.toLocaleLowerCase() === 'narrator' || entry.importance === 'main') continue;
    if (targetNames && !targetNames.has(entry.name.toLocaleLowerCase())) continue;
    if (entry.voiceId && validVoiceSet.has(entry.voiceId)) continue;

    const recommendations = recommendGeminiVoices({
      character: entry,
      voices: catalog,
      usedVoiceIds,
      narratorVoiceId,
    });
    const choice = recommendations.find((candidate) => !usedVoiceIds.has(candidate.voice.id))
      ?? recommendations[0];
    if (!choice) continue;

    entry.voiceId = choice.voice.id;
    entry.voiceAssignment = {
      provider: 'gemini',
      voiceId: choice.voice.id,
      assignedAt: input.assignedAt ?? Date.now(),
      assignmentSource: 'auto-assignment',
      catalogSnapshot: catalogSnapshot(choice.voice),
      reason: choice.reasons.length
        ? `Gemini catalog recommendation: ${choice.reasons.join('; ')}.`
        : 'Gemini catalog recommendation with least-conflicting available voice.',
    };
    usedVoiceIds.add(choice.voice.id);
    assigned.push({
      characterName: entry.name,
      voiceId: choice.voice.id,
      reason: entry.voiceAssignment.reason || 'Gemini catalog recommendation.',
    });
  }

  const candidateMap: SmartAudioCharacterMap = {
    ...input.characterMap,
    status: 'complete',
    entries,
  };
  delete candidateMap.needsRescan;
  const readiness = getCharacterMapReadiness(candidateMap, { validVoiceSet });
  const updatedMap: SmartAudioCharacterMap = {
    ...input.characterMap,
    status: readiness.ready ? 'complete' : input.characterMap.status,
    entries,
  };
  if (readiness.ready) delete updatedMap.needsRescan;
  return { updatedMap, assigned, protectedVoices: [...protectedVoices] };
}
