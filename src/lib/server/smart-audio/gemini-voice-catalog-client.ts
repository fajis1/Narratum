import {
  DEFAULT_ENGLISH_GEMINI_VOICE_LANGUAGES,
  normalizeGeminiVoiceCatalogEntry,
} from '@/lib/shared/gemini-voice-catalog';
import type {
  GeminiVoiceCatalogEntry,
  GeminiVoiceCatalogWireEntry,
} from '@/lib/shared/gemini-voice-catalog';

/** Isolated v1beta endpoint: the rest of Narratum never consumes its raw payload. */
export const GEMINI_VOICE_CATALOG_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/voices';
export const GEMINI_VOICE_CATALOG_PAGE_SIZE = 1_000;
export const GEMINI_VOICE_CATALOG_MAX_PAGES = 10;

export interface GeminiVoiceCatalogFetchOptions {
  /** Server-resolved profile key. It must never be passed from browser JSON. */
  apiKey: string;
  /** Initial scope is English prebuilt voices; callers can extend deliberately. */
  languageCodes?: readonly string[];
  /** Testable safeguard against an upstream pagination loop. */
  maxPages?: number;
}

export interface GeminiVoiceCatalogFetchResult {
  voices: GeminiVoiceCatalogEntry[];
  languageCodes: string[];
  fetchedAt: number;
  pageCount: number;
}

interface GeminiVoiceCatalogWireResponse {
  voices?: unknown;
  next_page_token?: unknown;
}

interface GeminiVoiceCatalogErrorPayload {
  error?: { message?: unknown; status?: unknown };
}

export class GeminiVoiceCatalogInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiVoiceCatalogInputError';
  }
}

export class GeminiVoiceCatalogApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly detail: string,
    public readonly providerStatus?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GeminiVoiceCatalogApiError';
  }
}

export class GeminiVoiceCatalogTransportError extends Error {
  constructor(cause: unknown) {
    super('Failed to reach the Gemini Voices endpoint.', { cause });
    this.name = 'GeminiVoiceCatalogTransportError';
  }
}

export class GeminiVoiceCatalogProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiVoiceCatalogProtocolError';
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function parseError(payload: unknown): { detail: string; providerStatus?: string } {
  if (!payload || typeof payload !== 'object') return { detail: 'No structured provider error body.' };
  const error = (payload as GeminiVoiceCatalogErrorPayload).error;
  if (!error || typeof error !== 'object') return { detail: 'No structured provider error body.' };
  return {
    detail: typeof error.message === 'string' ? error.message : 'Unspecified provider error.',
    providerStatus: typeof error.status === 'string' ? error.status : undefined,
  };
}

function normalizeLanguageCodes(languageCodes: readonly string[]): string[] {
  const result: string[] = [];
  for (const languageCode of languageCodes) {
    const normalized = languageCode.trim();
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(normalized)) {
      throw new GeminiVoiceCatalogInputError(`Invalid Gemini voice language code: ${languageCode}.`);
    }
    if (!result.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
      result.push(normalized);
    }
  }
  if (!result.length) throw new GeminiVoiceCatalogInputError('At least one Gemini voice language code is required.');
  return result;
}

/** Builds a stable ListVoices request URL. This intentionally allows no upstream URL input. */
export function buildGeminiVoiceCatalogUrl(input: {
  languageCodes: readonly string[];
  pageToken?: string;
}): string {
  const url = new URL(GEMINI_VOICE_CATALOG_ENDPOINT);
  url.searchParams.set('page_size', String(GEMINI_VOICE_CATALOG_PAGE_SIZE));
  url.searchParams.append('type', 'prebuilt');
  for (const languageCode of input.languageCodes) url.searchParams.append('language_code', languageCode);
  if (input.pageToken) url.searchParams.set('page_token', input.pageToken);
  return url.toString();
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new GeminiVoiceCatalogProtocolError('Gemini Voices returned malformed JSON.');
  }
}

/**
 * Fetches every English prebuilt Voices API page, normalizes records once, and
 * filters malformed/duplicate records before they reach the application.
 */
export async function fetchGeminiPrebuiltVoiceCatalog(
  options: GeminiVoiceCatalogFetchOptions,
): Promise<GeminiVoiceCatalogFetchResult> {
  if (!options.apiKey.trim()) throw new GeminiVoiceCatalogInputError('Gemini API key must not be empty.');
  const languageCodes = normalizeLanguageCodes(options.languageCodes ?? DEFAULT_ENGLISH_GEMINI_VOICE_LANGUAGES);
  const maxPages = options.maxPages ?? GEMINI_VOICE_CATALOG_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > GEMINI_VOICE_CATALOG_MAX_PAGES) {
    throw new GeminiVoiceCatalogInputError(`maxPages must be between 1 and ${GEMINI_VOICE_CATALOG_MAX_PAGES}.`);
  }

  const voices = new Map<string, GeminiVoiceCatalogEntry>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let pageCount = 0;

  for (;;) {
    if (pageCount >= maxPages) {
      throw new GeminiVoiceCatalogProtocolError(`Gemini Voices exceeded the ${maxPages}-page safety limit.`);
    }
    let response: Response;
    try {
      response = await fetch(buildGeminiVoiceCatalogUrl({ languageCodes, pageToken }), {
        method: 'GET',
        headers: { 'x-goog-api-key': options.apiKey },
      });
    } catch (error) {
      throw new GeminiVoiceCatalogTransportError(error);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      const { detail, providerStatus } = parseError(payload);
      throw new GeminiVoiceCatalogApiError(
        `Gemini Voices returned HTTP ${response.status}: ${detail}`,
        response.status,
        detail,
        providerStatus,
        parseRetryAfterMs(response.headers?.get('retry-after') ?? null),
      );
    }

    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as GeminiVoiceCatalogWireResponse).voices)) {
      throw new GeminiVoiceCatalogProtocolError('Gemini Voices response did not contain a voices array.');
    }
    for (const wireVoice of (payload as GeminiVoiceCatalogWireResponse).voices as GeminiVoiceCatalogWireEntry[]) {
      const voice = wireVoice && typeof wireVoice === 'object'
        ? normalizeGeminiVoiceCatalogEntry(wireVoice)
        : null;
      if (voice?.type === 'prebuilt' && !voices.has(voice.id)) voices.set(voice.id, voice);
    }

    pageCount += 1;
    const nextPageToken = (payload as GeminiVoiceCatalogWireResponse).next_page_token;
    if (typeof nextPageToken !== 'string' || !nextPageToken.trim()) break;
    pageToken = nextPageToken.trim();
    if (seenTokens.has(pageToken)) throw new GeminiVoiceCatalogProtocolError('Gemini Voices returned a repeated page token.');
    seenTokens.add(pageToken);
  }

  return {
    voices: [...voices.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    languageCodes,
    fetchedAt: Date.now(),
    pageCount,
  };
}
