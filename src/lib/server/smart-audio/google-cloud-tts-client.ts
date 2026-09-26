/**
 * google-cloud-tts-client.ts
 *
 * Stage 3 — Cloud Gemini-TTS Client Spike
 *
 * Lowest-level Google Cloud Text-to-Speech REST client for the
 * drama-gemini-tts worker mode. Synthesizes a single performance
 * segment to MP3 audio using `gemini-3.1-flash-tts-preview`.
 *
 * Responsibilities:
 *  - Byte-safe size enforcement (UTF-8 bytes, not JS char count).
 *  - In-process token caching with early-refresh margin.
 *  - Strict audio-tag allowlist enforcement before transmission.
 *  - Typed request/response shapes matching the Google Cloud TTS REST API.
 *
 * Non-responsibilities (handled by higher stages):
 *  - Chunking long texts (Stage 9).
 *  - Retry logic (Stage 9).
 *  - Review flags (Stage 9).
 *  - Director prompt building (Stage 8).
 *  - Character cast resolution (Stage 4+).
 */

import { resolveGoogleCloudBearerToken } from './google-cloud-auth';
import type { GoogleServiceAccountJson } from './google-cloud-auth';
import {
  DRAMA_AUDIO_TAG_ALLOWLIST,
  DRAMA_ONE_SHOT_TAGS,
  DRAMA_STYLE_TAGS,
  DRAMA_PAUSE_TAGS,
} from '@/lib/shared/drama-director-schema';
import type { DramaAudioTag } from '@/lib/shared/drama-director-schema';

export { DRAMA_ONE_SHOT_TAGS, DRAMA_STYLE_TAGS, DRAMA_PAUSE_TAGS };

// ── Endpoint ───────────────────────────────────────────────────────────────────

export const CLOUD_TTS_ENDPOINT =
  'https://texttospeech.googleapis.com/v1/text:synthesize';

export const CLOUD_TTS_MODEL = 'gemini-3.8-flash-tts';

export const CLOUD_TTS_FALLBACK_MODELS = [
  'gemini-3.7-flash-tts',
  'gemini-3.6-flash-tts',
  'gemini-3.1-flash-tts-preview',
] as const;

export const CLOUD_TTS_MODEL_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  'gemini-3.8-flash-tts': ['gemini-3.7-flash-tts', 'gemini-3.6-flash-tts', 'gemini-3.1-flash-tts-preview'],
  'gemini-3.8-flash-tts-preview': ['gemini-3.7-flash-tts-preview', 'gemini-3.6-flash-tts-preview', 'gemini-3.1-flash-tts-preview'],
  'gemini-3.8-flash': ['gemini-3.7-flash', 'gemini-3.6-flash'],
  'gemini-3.7-flash-tts': ['gemini-3.6-flash-tts', 'gemini-3.1-flash-tts-preview'],
  'gemini-3.7-flash-tts-preview': ['gemini-3.6-flash-tts-preview', 'gemini-3.1-flash-tts-preview'],
  'gemini-3.6-flash-tts': ['gemini-3.1-flash-tts-preview'],
  'gemini-3.6-flash-tts-preview': ['gemini-3.1-flash-tts-preview'],
};

export function resolveCloudTtsModelFallbacks(
  requestedModel?: string | null,
  customFallbacks?: readonly string[],
): string[] {
  const model = requestedModel?.trim() || CLOUD_TTS_MODEL;
  if (customFallbacks && customFallbacks.length > 0) {
    return [...new Set([model, ...customFallbacks.map((f) => f.trim()).filter(Boolean)])];
  }
  const fallbacks = CLOUD_TTS_MODEL_FALLBACKS[model] ?? CLOUD_TTS_FALLBACK_MODELS;
  return [...new Set([model, ...fallbacks])];
}

// ── Byte limits (conservative vs. the 4,000-byte hard cap) ────────────────────

/**
 * Google Cloud TTS hard limit per field.
 * https://cloud.google.com/text-to-speech/docs/quotas
 */
export const CLOUD_TTS_MAX_FIELD_BYTES = 4000;

/**
 * Conservative safe limit for the `input.text` field.
 * Enforced at call-site; caller must split before this boundary.
 */
export const CLOUD_TTS_SAFE_TEXT_BYTES = 3600;

/**
 * Conservative safe limit for the `input.prompt` (style/direction) field.
 */
export const CLOUD_TTS_SAFE_PROMPT_BYTES = 3600;

// ── Audio-tag allowlists ───────────────────────────────────────────────────────

/**
 * One-shot audio tags. These are complete, self-contained interjections.
 * They are REPLACED by the action — no text is spoken around the tag itself.
 * e.g. `[sigh]` — Google renders a sigh sound, not the word "sigh".
 */
export type DramaOneShotTag = (typeof DRAMA_ONE_SHOT_TAGS)[number];

/**
 * Style modifier tags. These wrap text and alter how it is spoken.
 * e.g. `[whispering] Careful, they're right there. [/whispering]`
 * Note: Google's tag syntax uses lowercase names without slashes for closing
 * only for one-shot tags; style tags use the same name for open and close.
 */
export type DramaStyleTag = (typeof DRAMA_STYLE_TAGS)[number];

/**
 * Pause tags. These insert silence of the indicated duration.
 * e.g. `[short pause]`
 */
export type DramaPauseTag = (typeof DRAMA_PAUSE_TAGS)[number];

export type AllowlistedAudioTag = DramaAudioTag;

/** Full flattened set of allowed tag names for O(1) lookup. */
export const DRAMA_ALLOWED_TAG_SET = new Set<string>(DRAMA_AUDIO_TAG_ALLOWLIST);

// ── Byte measurement ──────────────────────────────────────────────────────────

/**
 * Returns the UTF-8 byte length of a string.
 * Google Cloud TTS limits are in bytes, not JavaScript character count.
 */
export function measureUtf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Returns true if the string fits within the given byte limit.
 */
export function fitsWithinByteLimit(text: string, limitBytes: number): boolean {
  return measureUtf8Bytes(text) <= limitBytes;
}

// ── Tag stripping ─────────────────────────────────────────────────────────────

/**
 * Strip any `[...]` tags from text that are NOT in the production allowlist.
 *
 * This is the last safety gate before a request is sent to Google.
 * The Drama Director is expected to only emit allowed tags, but this
 * function guarantees no disallowed tags leak through.
 *
 * Allowed tag forms:
 *   [one-shot-tag]         → one-shot (kept as-is)
 *   [style-tag] ... [style-tag]  → style wrapper (both opening and closing kept)
 *   [pause-tag]            → pause (kept as-is)
 *
 * Any tag whose name is not in DRAMA_ALLOWED_TAG_SET is removed entirely.
 */
export function stripDisallowedTags(text: string): { sanitized: string; stripped: string[] } {
  const stripped: string[] = [];
  const sanitized = text.replace(/\[([^\]]+)\]/gu, (match, tagContent: string) => {
    const name = tagContent.trim().toLowerCase();
    if (DRAMA_ALLOWED_TAG_SET.has(name)) return match;
    stripped.push(match);
    return '';
  });
  return { sanitized: sanitized.replace(/  +/gu, ' ').trim(), stripped };
}

// ── Token cache ───────────────────────────────────────────────────────────────

const REFRESH_MARGIN_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * In-process token cache for Google Cloud bearer tokens.
 * One cache per `cacheKey` (typically the SA JSON hash or 'adc').
 *
 * This is a simple synchronous+async cache — concurrent requests that arrive
 * during an in-flight refresh will all wait on the same promise.
 */
export class GoogleCloudTokenCache {
  private readonly _cache = new Map<string, CachedToken>();
  private readonly _inflight = new Map<string, Promise<CachedToken>>();

  /**
   * Get a valid bearer token, refreshing if needed.
   *
   * @param cacheKey    Unique key per credential set (e.g. SA client_email or 'adc').
   * @param fetcher     Async function that returns a fresh `{ accessToken, expiresAtMs }`.
   */
  async getToken(
    cacheKey: string,
    fetcher: () => Promise<{ accessToken: string; expiresAtMs: number }>,
  ): Promise<string> {
    const cached = this._cache.get(cacheKey);
    if (cached && cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) {
      return cached.accessToken;
    }

    // Coalesce concurrent refresh requests
    const existing = this._inflight.get(cacheKey);
    if (existing) {
      const token = await existing;
      return token.accessToken;
    }

    const refresh = fetcher().then((result) => {
      const entry: CachedToken = {
        accessToken: result.accessToken,
        expiresAtMs: result.expiresAtMs,
      };
      this._cache.set(cacheKey, entry);
      this._inflight.delete(cacheKey);
      return entry;
    }).catch((err: unknown) => {
      this._inflight.delete(cacheKey);
      throw err;
    });

    this._inflight.set(cacheKey, refresh);
    const token = await refresh;
    return token.accessToken;
  }

  /** Evict a specific key (e.g. after a 401 response). */
  evict(cacheKey: string): void {
    this._cache.delete(cacheKey);
  }

  /** Clear the entire cache (for testing). */
  clear(): void {
    this._cache.clear();
    this._inflight.clear();
  }
}

/** Module-level singleton cache — shared across all chapter jobs in the same process. */
export const tokenCache = new GoogleCloudTokenCache();

// ── REST request/response types ───────────────────────────────────────────────

export interface CloudTtsSynthesisInput {
  /** The spoken text, optionally containing allowlisted audio tags. */
  text: string;
  /**
   * The style/direction prompt sent to Gemini-TTS.
   * This is where emotion, pace, delivery, and character identity belong.
   */
  prompt?: string;
}

export interface CloudTtsVoiceSelectionParams {
  /** Voice name from the Gemini TTS catalog, e.g. "Kore", "Orus". */
  name: string;
  /**
   * Language code. Google Cloud TTS requires this even for Gemini voices.
   * Defaults to "en-US" for all English audiobooks.
   */
  languageCode?: string;
  modelName?: string;
}

export interface CloudTtsAudioConfig {
  /**
   * Audio encoding for Gemini-TTS output.
   * "MP3" is supported and preferred for streaming stitching.
   */
  audioEncoding: 'MP3' | 'LINEAR16' | 'OGG_OPUS';
  speakingRate?: number;
  pitch?: number;
}

/** Shape of the JSON body sent to the Cloud TTS REST endpoint. */
export interface CloudTtsSynthesizeRequest {
  input: { text: string; prompt?: string };
  voice: {
    name: string;
    languageCode: string;
    modelName: string;
  };
  audioConfig: {
    audioEncoding: string;
    speakingRate?: number;
    pitch?: number;
  };
}

/** Shape of the successful JSON response from Cloud TTS. */
export interface CloudTtsSynthesizeResponse {
  /** Base64-encoded audio content (MP3 or other requested format). */
  audioContent: string;
}

// ── Main synthesis options ────────────────────────────────────────────────────

export interface CloudTtsSynthesisOptions {
  /** The text segment to synthesize. Must be within CLOUD_TTS_SAFE_TEXT_BYTES. */
  text: string;
  /**
   * The style/direction prompt for this segment.
   * Must be within CLOUD_TTS_SAFE_PROMPT_BYTES.
   */
  stylePrompt?: string;
  technicalOverrides?: { speakingRate?: number; pitch?: number };
  /** Voice name from the Gemini TTS Cloud catalog. */
  voiceName: string;
  /** Language code; defaults to 'en-US'. */
  languageCode?: string;
  /** Optional Gemini TTS model name. Defaults to CLOUD_TTS_MODEL ('gemini-3.8-flash-tts'). */
  modelName?: string;
  /**
   * Service Account JSON for this profile.
   * If absent, falls back to Application Default Credentials.
   */
  serviceAccountJson?: string;
  /**
   * Cache key for this credential set. Used to coalesce token refreshes.
   * Typically the SA client_email or 'adc'.
   */
  credentialCacheKey?: string;
  /**
   * Optional override for the token cache instance.
   * Used in tests to inject a mock cache.
   */
  tokenCacheOverride?: GoogleCloudTokenCache;
}

export interface CloudTtsSynthesisResult {
  /** Raw MP3 audio data. */
  audioBuffer: Buffer;
  /** The access token cache key that was used (for debugging/logging). */
  credentialCacheKey: string;
  /**
   * Any tags that were stripped before synthesis because they were not
   * in the production allowlist.
   */
  strippedTags: string[];
  /** The Cloud TTS model name that was used for synthesis. */
  usedModel: string;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class CloudTtsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudTtsInputError';
  }
}

export class CloudTtsApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly detail: string,
  ) {
    super(message);
    this.name = 'CloudTtsApiError';
  }
}

export class CloudTtsQuotaExhaustedError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 429,
    public readonly isDailyQuota: boolean = true,
  ) {
    super(message);
    this.name = 'CloudTtsQuotaExhaustedError';
  }
}

export function isCloudTtsQuotaExhaustedError(error: unknown): boolean {
  if (error instanceof CloudTtsQuotaExhaustedError) return true;
  if (error instanceof CloudTtsApiError) {
    if (error.statusCode === 429) return true;
    if (error.statusCode === 403) {
      const lower = (error.detail || error.message).toLowerCase();
      return lower.includes('quota') || lower.includes('credit') || lower.includes('resource_exhausted') || lower.includes('billing') || lower.includes('limit');
    }
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (message.includes('429') || message.includes('quota') || message.includes('resource_exhausted') || message.includes('credit') || message.includes('rate limit')) &&
    !message.includes('director validation');
}

export class CloudTtsTransportError extends Error {
  constructor(cause: unknown) {
    super('Failed to reach Google Cloud TTS endpoint.', { cause });
    this.name = 'CloudTtsTransportError';
  }
}

/** Build the documented REST body and check the final UTF-8 field sizes. */
export function buildCloudTtsRequest(options: Pick<CloudTtsSynthesisOptions,
  'text' | 'stylePrompt' | 'voiceName' | 'languageCode' | 'technicalOverrides' | 'modelName'>): CloudTtsSynthesizeRequest {
  const { sanitized: text } = stripDisallowedTags(options.text);
  const prompt = options.stylePrompt;
  if (!options.voiceName.trim()) throw new CloudTtsInputError('Voice name must not be empty.');
  if (!text) throw new CloudTtsInputError('Text must not be empty.');
  if (measureUtf8Bytes(text) > CLOUD_TTS_SAFE_TEXT_BYTES) {
    throw new CloudTtsInputError(`Text exceeds the safe limit of ${CLOUD_TTS_SAFE_TEXT_BYTES} bytes.`);
  }
  if (prompt && measureUtf8Bytes(prompt) > CLOUD_TTS_SAFE_PROMPT_BYTES) {
    throw new CloudTtsInputError(`Style prompt exceeds the safe limit of ${CLOUD_TTS_SAFE_PROMPT_BYTES} bytes.`);
  }
  const { speakingRate, pitch } = options.technicalOverrides ?? {};
  if (speakingRate !== undefined && (!Number.isFinite(speakingRate) || speakingRate < 0.25 || speakingRate > 2)) {
    throw new CloudTtsInputError('Speaking rate must be between 0.25 and 2.0.');
  }
  if (pitch !== undefined && (!Number.isFinite(pitch) || pitch < -20 || pitch > 20)) {
    throw new CloudTtsInputError('Pitch must be between -20 and 20 semitones.');
  }
  return {
    input: { text, ...(prompt ? { prompt } : {}) },
    voice: { name: options.voiceName, languageCode: options.languageCode ?? 'en-US', modelName: options.modelName || CLOUD_TTS_MODEL },
    audioConfig: {
      audioEncoding: 'MP3',
      ...(speakingRate !== undefined ? { speakingRate } : {}),
      ...(pitch !== undefined ? { pitch } : {}),
    },
  };
}

// ── Main synthesis function ───────────────────────────────────────────────────

/**
 * Synthesize a single performance segment to MP3 audio using
 * Google Cloud Text-to-Speech with `gemini-3.1-flash-tts-preview`.
 *
 * This is the atomic synthesis unit. Callers are responsible for:
 * - Splitting text to fit within CLOUD_TTS_SAFE_TEXT_BYTES (Stage 9).
 * - Retrying on transient errors (Stage 9).
 * - Adding review flags on permanent failure (Stage 9).
 *
 * @throws {CloudTtsInputError}  Text or prompt exceeds byte limits, or voice name is empty.
 * @throws {GoogleCloudAuthError} Token cannot be obtained.
 * @throws {CloudTtsApiError}    Google's API returned a non-OK HTTP status.
 */
export async function synthesizeWithCloudTts(
  options: CloudTtsSynthesisOptions,
): Promise<CloudTtsSynthesisResult> {
  const {
    text: rawText,
    stylePrompt,
    voiceName,
    languageCode = 'en-US',
    serviceAccountJson,
    credentialCacheKey: suppliedCacheKey,
    tokenCacheOverride,
    technicalOverrides,
  } = options;

  // ── 1. Validate voice ──────────────────────────────────────────────────────

  if (!voiceName.trim()) {
    throw new CloudTtsInputError('Voice name must not be empty.');
  }

  // ── 2. Strip disallowed tags ───────────────────────────────────────────────

  const { sanitized: text, stripped: strippedTags } = stripDisallowedTags(rawText);

  // ── 3. Enforce byte limits ─────────────────────────────────────────────────

  const textBytes = measureUtf8Bytes(text);
  if (textBytes > CLOUD_TTS_SAFE_TEXT_BYTES) {
    throw new CloudTtsInputError(
      `Text is ${textBytes} bytes, exceeding the safe limit of ${CLOUD_TTS_SAFE_TEXT_BYTES} bytes. ` +
      'Split the segment before calling synthesizeWithCloudTts.',
    );
  }

  if (stylePrompt) {
    const promptBytes = measureUtf8Bytes(stylePrompt);
    if (promptBytes > CLOUD_TTS_SAFE_PROMPT_BYTES) {
      throw new CloudTtsInputError(
        `Style prompt is ${promptBytes} bytes, exceeding the safe limit of ${CLOUD_TTS_SAFE_PROMPT_BYTES} bytes.`,
      );
    }
  }

  // ── 4. Resolve bearer token ────────────────────────────────────────────────

  const cache = tokenCacheOverride ?? tokenCache;
  const cacheKey = suppliedCacheKey ?? (serviceAccountJson ? 'sa-json' : 'adc');

  const accessToken = await cache.getToken(cacheKey, () =>
    resolveGoogleCloudBearerToken({ serviceAccountJson }),
  );

  // ── 5. Build request body ──────────────────────────────────────────────────

  const requestBody = buildCloudTtsRequest({
    text,
    stylePrompt,
    voiceName,
    languageCode,
    technicalOverrides,
    modelName: options.modelName,
  });

  // ── 6. Make the request ────────────────────────────────────────────────────

  let response: Response;
  try {
    response = await fetch(CLOUD_TTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new CloudTtsTransportError(err);
  }

  // ── 7. Handle errors ───────────────────────────────────────────────────────

  if (!response.ok) {
    // Evict the token cache on auth errors so the next call attempts a fresh token.
    if (response.status === 401 || response.status === 403) {
      cache.evict(cacheKey);
    }

    let detail = '';
    try {
      const body = await response.json() as Record<string, unknown>;
      const errorObj = body.error as Record<string, unknown> | undefined;
      detail = typeof errorObj?.message === 'string'
        ? errorObj.message
        : JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => `HTTP ${response.status}`);
    }

    throw new CloudTtsApiError(
      `Google Cloud TTS returned HTTP ${response.status}: ${detail}`,
      response.status,
      detail,
    );
  }

  // ── 8. Parse audio response ────────────────────────────────────────────────

  const json = await response.json() as Record<string, unknown>;
  if (typeof json.audioContent !== 'string' || !json.audioContent) {
    throw new CloudTtsApiError(
      'Google Cloud TTS response did not include audioContent.',
      response.status,
      'Missing audioContent field',
    );
  }

  const audioBuffer = Buffer.from(json.audioContent, 'base64');

  return {
    audioBuffer,
    credentialCacheKey: cacheKey,
    strippedTags,
    usedModel: options.modelName || CLOUD_TTS_MODEL,
  };
}
