/**
 * Normalized, provider-safe representation of Gemini Voices API metadata.
 *
 * Keep raw v1beta payloads inside the server adapter. UI, matching, and
 * persistence use this stable shape so future provider changes stay local.
 */
export type GeminiVoiceGender = 'female' | 'male' | 'neutral' | 'unknown';
export type GeminiVoicePitch = 'low' | 'medium' | 'high' | 'unknown';
export type GeminiVoiceType = 'prebuilt' | 'prompted' | 'replicated';

export interface GeminiVoiceCatalogEntry {
  id: string;
  displayName: string;
  languageCode: string | null;
  regionCode: string | null;
  accent: string | null;
  /** Google's perceived voice gender presentation, not a biological-sex claim. */
  gender: GeminiVoiceGender;
  pitch: GeminiVoicePitch;
  persona: string | null;
  context: string | null;
  description: string | null;
  type: GeminiVoiceType;
  model: string | null;
  expireTime: string | null;
}

/**
 * An empty upstream language filter means ListVoices returns every prebuilt
 * voice. The server then keeps all English variants locally (`en` / `en-*`),
 * instead of silently limiting Narratum to two locales.
 */
export const DEFAULT_ENGLISH_GEMINI_VOICE_LANGUAGES: readonly string[] = [];

export function isEnglishGeminiVoiceLanguage(languageCode: string | null): boolean {
  const normalized = languageCode?.trim().toLowerCase();
  return normalized === 'en' || Boolean(normalized?.startsWith('en-'));
}

export interface GeminiVoiceCatalogWireEntry {
  id?: unknown;
  display_name?: unknown;
  language_code?: unknown;
  region_code?: unknown;
  accent?: unknown;
  gender?: unknown;
  pitch?: unknown;
  persona?: unknown;
  context?: unknown;
  description?: unknown;
  type?: unknown;
  model?: unknown;
  expire_time?: unknown;
}

function nullableTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeGeminiVoiceGender(value: unknown): GeminiVoiceGender {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'female': return 'female';
    case 'male': return 'male';
    case 'neutral': return 'neutral';
    default: return 'unknown';
  }
}

export function normalizeGeminiVoicePitch(value: unknown): GeminiVoicePitch {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    default: return 'unknown';
  }
}

/**
 * Unknown future voice types are not silently treated as prebuilt. The caller
 * can reject them while the normalizer stays forward-compatible with missing
 * optional metadata.
 */
export function normalizeGeminiVoiceType(value: unknown): GeminiVoiceType | null {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'prebuilt': return 'prebuilt';
    case 'prompted': return 'prompted';
    case 'replicated': return 'replicated';
    default: return null;
  }
}

/**
 * Normalizes a single Voices API record. Invalid records return null instead of
 * leaking an incomplete provider object into application state.
 */
export function normalizeGeminiVoiceCatalogEntry(
  value: GeminiVoiceCatalogWireEntry,
): GeminiVoiceCatalogEntry | null {
  const id = nullableTrimmedString(value.id);
  const type = normalizeGeminiVoiceType(value.type);
  if (!id || !type) return null;

  return {
    id,
    displayName: nullableTrimmedString(value.display_name) ?? id,
    languageCode: nullableTrimmedString(value.language_code),
    regionCode: nullableTrimmedString(value.region_code),
    accent: nullableTrimmedString(value.accent),
    gender: normalizeGeminiVoiceGender(value.gender),
    pitch: normalizeGeminiVoicePitch(value.pitch),
    persona: nullableTrimmedString(value.persona),
    context: nullableTrimmedString(value.context),
    description: nullableTrimmedString(value.description),
    type,
    model: nullableTrimmedString(value.model),
    expireTime: nullableTrimmedString(value.expire_time),
  };
}

/** Syntactic guard only; current-catalog membership is validated server-side. */
export function isSafeGeminiVoiceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9_.-]+$/.test(value);
}
