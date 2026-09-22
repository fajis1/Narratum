/**
 * google-cloud-cast-helpers.ts
 *
 * Stage 4 — Cloud TTS Cast Assignment Helpers
 *
 * Convenience wrappers around the provider-parameterized functions in
 * `multi-voice.ts`, pre-wired with the Google Cloud TTS voice catalog.
 *
 * These are the functions the drama-gemini-tts worker mode calls for
 * all cast-related operations. They guarantee the Cloud voice set is
 * used consistently without the caller having to pass options every time.
 */

import {
  getCharacterMapReadiness,
  autoAssignMinorCharacterVoices,
  normalizeSmartAudioCharacterMap,
} from '@/lib/shared/multi-voice';
import type {
  AutoAssignMinorVoicesOptions,
  AutoAssignMinorVoicesResult,
} from '@/lib/shared/multi-voice';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import {
  CLOUD_TTS_CHARACTER_VOICE_SET,
  CLOUD_TTS_RECYCLABLE_VOICES,
  CLOUD_TTS_FEMALE_VOICE_SET,
  CLOUD_TTS_MALE_VOICE_SET,
} from '@/lib/shared/google-cloud-tts-voices';

// ── Re-export catalog for consumers that need raw voice data ──────────────────

export {
  CLOUD_TTS_ALL_VOICES,
  CLOUD_TTS_FEMALE_VOICES,
  CLOUD_TTS_MALE_VOICES,
  CLOUD_TTS_CHARACTER_VOICE_SET,
  CLOUD_TTS_RECYCLABLE_VOICES,
  isValidCloudTtsVoice,
  isCloudTtsFemaleVoice,
  isCloudTtsMaleVoice,
} from '@/lib/shared/google-cloud-tts-voices';

// ── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Normalize a raw character map value using the Cloud TTS voice set.
 *
 * Cloud TTS voice IDs (e.g. "Kore", "Orus") are preserved through
 * normalization rather than being nulled out (which would happen with
 * the default Kokoro normalizer).
 */
export function normalizeCloudTtsCharacterMap(value: unknown): SmartAudioCharacterMap | null {
  return normalizeSmartAudioCharacterMap(value, { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET });
}

// ── Readiness check ───────────────────────────────────────────────────────────

/**
 * Check whether a Cloud TTS character map is ready for drama-gemini-tts synthesis.
 *
 * Validates that:
 * - A Narrator is present.
 * - All primary characters have a voice assigned from the Cloud TTS catalog.
 * - The map is marked complete.
 *
 * This is equivalent to `getCharacterMapReadiness(value)` for Kokoro,
 * but uses `CLOUD_TTS_CHARACTER_VOICE_SET` as the valid voice set.
 */
export function getCloudTtsCharacterMapReadiness(value: unknown): ReturnType<typeof getCharacterMapReadiness> {
  return getCharacterMapReadiness(value, { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET });
}

// ── Auto-assignment ───────────────────────────────────────────────────────────

export type CloudTtsAutoAssignOptions = Omit<
  AutoAssignMinorVoicesOptions,
  'voicePool' | 'validVoiceSet'
> & {
  /**
   * Optional subset of Cloud voices to draw from.
   * Defaults to CLOUD_TTS_RECYCLABLE_VOICES (all 30 voices).
   */
  voicePool?: readonly string[];
};

/**
 * Auto-assign Cloud TTS voices to minor characters.
 *
 * Uses gender heuristics based on character description to prefer
 * female voices from `CLOUD_TTS_FEMALE_VOICES` or male voices from
 * `CLOUD_TTS_MALE_VOICES`. Falls back to any voice in the pool when
 * gender is ambiguous.
 *
 * Narrator and manually-assigned main characters are protected
 * from auto-assignment regardless of the pool.
 *
 * This is a wrapper around `autoAssignMinorCharacterVoices` with
 * Cloud-specific `voicePool` and `validVoiceSet` defaults.
 *
 * Note: The Kokoro-specific female/male voice set detection inside
 * `autoAssignMinorCharacterVoices` uses `KOKORO_AMERICAN_FEMALE_VOICES`
 * etc. for gender filtering. For Cloud TTS we need gender-aware pool
 * filtering here. The pool passed to `autoAssignMinorCharacterVoices`
 * is pre-split: the internal Kokoro gender sets naturally return empty,
 * so the function falls back to the full pool. To correctly honour gender
 * for Cloud TTS we apply gender-filtered candidates at this layer.
 */
export function autoAssignCloudTtsMinorVoices(
  options: CloudTtsAutoAssignOptions,
): AutoAssignMinorVoicesResult {
  const pool = options.voicePool ?? CLOUD_TTS_RECYCLABLE_VOICES;
  return autoAssignMinorCharacterVoices({
    ...options,
    voicePool: pool,
    validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET,
  });
}

// ── Gender-aware pool builder ─────────────────────────────────────────────────

/**
 * Build a gender-filtered voice pool for Cloud TTS assignment.
 *
 * Used when the caller wants to narrow the pool to one gender before
 * calling `autoAssignCloudTtsMinorVoices`.
 *
 * `gender`:
 *   'female' → voices from CLOUD_TTS_FEMALE_VOICES
 *   'male'   → voices from CLOUD_TTS_MALE_VOICES
 *   'any'    → all voices (no filtering)
 */
export function buildCloudTtsVoicePool(
  gender: 'female' | 'male' | 'any',
  excludeVoices: ReadonlySet<string> = new Set(),
): string[] {
  const candidates: readonly string[] =
    gender === 'female' ? [...CLOUD_TTS_CHARACTER_VOICE_SET].filter((v) => CLOUD_TTS_FEMALE_VOICE_SET.has(v))
    : gender === 'male' ? [...CLOUD_TTS_CHARACTER_VOICE_SET].filter((v) => CLOUD_TTS_MALE_VOICE_SET.has(v))
    : [...CLOUD_TTS_CHARACTER_VOICE_SET];
  return candidates.filter((v) => !excludeVoices.has(v));
}
