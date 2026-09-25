/**
 * google-cloud-tts-voices.ts
 *
 * Stage 4 — Gemini Cloud Voice Catalog
 *
 * Gender-categorized voice catalog for `gemini-3.1-flash-tts-preview` voices
 * available through Google Cloud Text-to-Speech.
 *
 * Source: Google Cloud TTS Gemini voice catalog (verified 2026-09-18).
 *
 * These names match exactly those in `GEMINI_FLASH_TTS_VOICES` in
 * `tts-provider-catalog.ts` (used by the Replicate path) and are the
 * same names supplied as `voice.name` in the Cloud TTS REST request.
 *
 * Gender categorization is used only for heuristic auto-assignment of
 * minor characters. Users always have final control over voice selection.
 */

// ── Female voices (14) ────────────────────────────────────────────────────────

export const CLOUD_TTS_FEMALE_VOICES = [
  'Achernar',
  'Aoede',
  'Autonoe',
  'Callirrhoe',
  'Despina',
  'Erinome',
  'Gacrux',
  'Kore',
  'Laomedeia',
  'Leda',
  'Pulcherrima',
  'Sulafat',
  'Vindemiatrix',
  'Zephyr',
] as const;

export type CloudTtsFemaleVoice = (typeof CLOUD_TTS_FEMALE_VOICES)[number];

// ── Male voices (16) ──────────────────────────────────────────────────────────

export const CLOUD_TTS_MALE_VOICES = [
  'Achird',
  'Algenib',
  'Algieba',
  'Alnilam',
  'Charon',
  'Enceladus',
  'Fenrir',
  'Iapetus',
  'Orus',
  'Puck',
  'Rasalgethi',
  'Sadachbia',
  'Sadaltager',
  'Schedar',
  'Umbriel',
  'Zubenelgenubi',
] as const;

export type CloudTtsMaleVoice = (typeof CLOUD_TTS_MALE_VOICES)[number];

export const CLOUD_TTS_MODEL = 'gemini-3.1-flash-tts-preview';

// ── Combined catalog (30) ─────────────────────────────────────────────────────

/**
 * All Gemini Cloud TTS voices in a stable order.
 * Used as the source of truth for voice validation in the drama-gemini-tts
 * worker mode. Names are case-sensitive as required by the Cloud TTS API.
 */
export const CLOUD_TTS_ALL_VOICES = [
  ...CLOUD_TTS_FEMALE_VOICES,
  ...CLOUD_TTS_MALE_VOICES,
] as const;

export type CloudTtsVoiceName = (typeof CLOUD_TTS_ALL_VOICES)[number];

/**
 * Set of all valid Cloud TTS voice names for O(1) membership testing.
 * Used by `getCharacterMapReadiness` and `autoAssignMinorCharacterVoices`
 * in `validVoiceSet` and as the skip-check in the assignment loop.
 */
export const CLOUD_TTS_CHARACTER_VOICE_SET = new Set<string>(CLOUD_TTS_ALL_VOICES);

// ── Recyclable pool for auto-assignment ───────────────────────────────────────

/**
 * Voices eligible for automatic minor-character assignment.
 *
 * All 30 Cloud TTS voices are eligible. Unlike the Kokoro pool (which
 * distinguishes "recyclable" from narrator-quality voices), all Gemini
 * Cloud TTS voices are expressive enough for any character role.
 *
 * Narrator and manually-assigned main characters are protected from
 * reuse by the auto-assignment logic regardless.
 */
export const CLOUD_TTS_RECYCLABLE_VOICES = CLOUD_TTS_ALL_VOICES;

// ── Gender membership sets (for assignment heuristics) ────────────────────────

export const CLOUD_TTS_FEMALE_VOICE_SET = new Set<string>(CLOUD_TTS_FEMALE_VOICES);
export const CLOUD_TTS_MALE_VOICE_SET = new Set<string>(CLOUD_TTS_MALE_VOICES);

/**
 * Returns true when the given voice name is in the female catalog.
 */
export function isCloudTtsFemaleVoice(name: string): boolean {
  return CLOUD_TTS_FEMALE_VOICE_SET.has(name);
}

/**
 * Returns true when the given voice name is in the male catalog.
 */
export function isCloudTtsMaleVoice(name: string): boolean {
  return CLOUD_TTS_MALE_VOICE_SET.has(name);
}

/**
 * Returns true when the given voice name exists in the Cloud TTS catalog.
 */
export function isValidCloudTtsVoice(name: string): boolean {
  return CLOUD_TTS_CHARACTER_VOICE_SET.has(name);
}
