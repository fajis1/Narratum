import {
  getCharacterMapReadiness,
  normalizeSmartAudioCharacterMap,
} from '@/lib/shared/multi-voice';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { resolveGeminiPrebuiltVoiceCatalog } from './gemini-voice-catalog-cache';
import type { ResolvedGeminiVoiceCatalog } from './gemini-voice-catalog-cache';

/**
 * Gemini catalog-aware cast helpers. Stored IDs survive temporary catalog
 * outages, while readiness always verifies assignments against the resolved
 * live/cache/snapshot catalog before synthesis is allowed.
 */
export function normalizeGeminiTtsCharacterMap(value: unknown): SmartAudioCharacterMap | null {
  return normalizeSmartAudioCharacterMap(value, { preserveSafeVoiceIds: true });
}

export interface GeminiCharacterMapReadiness {
  ready: boolean;
  map: SmartAudioCharacterMap | null;
  unassigned: string[];
  unassignedMain: string[];
  unassignedMinor: string[];
  errors: string[];
  catalog: Pick<ResolvedGeminiVoiceCatalog, 'source' | 'fetchedAt' | 'catalogVersion'>;
}

export async function getGeminiTtsCharacterMapReadiness(input: {
  value: unknown;
  apiKey: string;
  languageCodes?: readonly string[];
  resolveCatalog?: typeof resolveGeminiPrebuiltVoiceCatalog;
}): Promise<GeminiCharacterMapReadiness> {
  const resolveCatalog = input.resolveCatalog ?? resolveGeminiPrebuiltVoiceCatalog;
  const catalog = await resolveCatalog({ apiKey: input.apiKey, languageCodes: input.languageCodes });
  const readiness = getCharacterMapReadiness(input.value, {
    validVoiceSet: new Set(catalog.voices.map((voice) => voice.id)),
  });
  return {
    ...readiness,
    catalog: {
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      catalogVersion: catalog.catalogVersion,
    },
  };
}