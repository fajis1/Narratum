import type { GeminiVoiceCatalogEntry } from './gemini-voice-catalog';

export type GeminiVoiceModelTier = 'flash' | 'flash-lite';

/** Missing legacy model metadata is treated as the primary Flash catalog. */
export function geminiVoiceModelTier(voice: GeminiVoiceCatalogEntry): GeminiVoiceModelTier {
  return voice.model?.toLocaleLowerCase().includes('flash-lite') ? 'flash-lite' : 'flash';
}

export function filterGeminiVoicesByModelTier(
  voices: readonly GeminiVoiceCatalogEntry[],
  tier: GeminiVoiceModelTier,
  currentVoiceId?: string | null,
): GeminiVoiceCatalogEntry[] {
  return voices.filter((voice) => voice.id === currentVoiceId || geminiVoiceModelTier(voice) === tier);
}

export type GeminiVoiceGenderFilter = 'all' | 'female' | 'male' | 'neutral' | 'unknown';
export type GeminiVoicePitchFilter = 'all' | 'low' | 'medium' | 'high' | 'unknown';

export interface GeminiVoiceLibraryFilters {
  query: string;
  gender: GeminiVoiceGenderFilter;
  pitch: GeminiVoicePitchFilter;
  accent: string;
  context: string;
  hideUsed: boolean;
  currentVoiceId?: string | null;
}

/** Filters public Gemini metadata while always retaining the current choice. */
export function filterGeminiVoiceLibrary(
  voices: readonly GeminiVoiceCatalogEntry[],
  filters: GeminiVoiceLibraryFilters,
  usedVoiceIds: ReadonlySet<string>,
): GeminiVoiceCatalogEntry[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return voices.filter((voice) => {
    if (voice.id === filters.currentVoiceId) return true;
    const searchable = [
      voice.id, voice.displayName, voice.languageCode, voice.accent, voice.gender,
      voice.pitch, voice.persona, voice.context, voice.description,
    ].filter(Boolean).join(' ').toLocaleLowerCase();
    if (query && !searchable.includes(query)) return false;
    if (filters.gender !== 'all' && voice.gender !== filters.gender) return false;
    if (filters.pitch !== 'all' && voice.pitch !== filters.pitch) return false;
    if (filters.accent !== 'all' && voice.accent !== filters.accent) return false;
    if (filters.context !== 'all' && voice.context !== filters.context) return false;
    return !filters.hideUsed || !usedVoiceIds.has(voice.id);
  });
}

export function listGeminiVoiceMetadataValues(
  voices: readonly GeminiVoiceCatalogEntry[],
  field: 'accent' | 'context',
): string[] {
  return [...new Set(voices.map((voice) => voice[field]?.trim()).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right));
}

export function formatGeminiVoiceMetadata(voice: GeminiVoiceCatalogEntry): string {
  return [
    voice.gender === 'unknown' ? null : voice.gender[0].toUpperCase() + voice.gender.slice(1),
    voice.pitch === 'unknown' ? null : `${voice.pitch[0].toUpperCase() + voice.pitch.slice(1)} pitch`,
    voice.accent,
    voice.persona,
    voice.context,
  ].filter(Boolean).join(' ? ') || 'Metadata unavailable';
}

export function formatGeminiAssignmentReason(input: {
  assignmentSource?: 'user' | 'prescan-recommendation' | 'auto-assignment';
  reason?: string;
}): string {
  if (input.assignmentSource === 'user') return 'Selected by you';
  const reason = input.reason?.replace(/^Gemini catalog recommendation:\s*/iu, '').trim();
  return reason || (input.assignmentSource === 'auto-assignment'
    ? 'Assigned from Gemini Voice Library metadata.'
    : input.assignmentSource === 'prescan-recommendation'
      ? 'Recommended from Gemini Voice Library metadata.'
      : '');
}
