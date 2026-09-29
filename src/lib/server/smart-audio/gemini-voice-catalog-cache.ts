import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import {
  CLOUD_TTS_FEMALE_VOICE_SET,
  CLOUD_TTS_ALL_VOICES,
} from '@/lib/shared/google-cloud-tts-voices';
import { isSafeGeminiVoiceId } from '@/lib/shared/gemini-voice-catalog';
import type { GeminiVoiceCatalogEntry } from '@/lib/shared/gemini-voice-catalog';
import {
  fetchGeminiPrebuiltVoiceCatalog,
} from './gemini-voice-catalog-client';
import { GeminiVoiceCatalogApiError } from './gemini-voice-catalog-client';
import type { GeminiVoiceCatalogFetchResult } from './gemini-voice-catalog-client';

export const GEMINI_VOICE_CATALOG_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
export const GEMINI_VOICE_CATALOG_SNAPSHOT_KEY = 'system:gemini-prebuilt-voice-catalog:v1';
const SNAPSHOT_VERSION = 1;

export type GeminiVoiceCatalogSource = 'live' | 'cache' | 'snapshot' | 'legacy-fallback';

export interface GeminiVoiceCatalogStatusNotice {
  code: 'authentication' | 'permission' | 'rate-limit' | 'unavailable';
  message: string;
  retryAfterMs?: number;
}

export interface GeminiVoiceCatalogSnapshot {
  version: typeof SNAPSHOT_VERSION;
  catalogVersion: string;
  fetchedAt: number;
  languageCodes: string[];
  voices: GeminiVoiceCatalogEntry[];
}

export interface ResolvedGeminiVoiceCatalog {
  source: GeminiVoiceCatalogSource;
  fetchedAt: number;
  catalogVersion: string;
  voices: GeminiVoiceCatalogEntry[];
  languageCodes: string[];
  /** A safe, non-secret notice when serving last-known-good data. */
  statusNotice?: GeminiVoiceCatalogStatusNotice;
}

type FetchCatalog = (input: {
  apiKey: string;
  languageCodes?: readonly string[];
}) => Promise<GeminiVoiceCatalogFetchResult>;

type ReadSnapshot = () => Promise<GeminiVoiceCatalogSnapshot | null>;
type WriteSnapshot = (snapshot: GeminiVoiceCatalogSnapshot) => Promise<void>;

export interface ResolveGeminiVoiceCatalogOptions {
  apiKey: string;
  languageCodes?: readonly string[];
  now?: () => number;
  fetchCatalog?: FetchCatalog;
  readSnapshot?: ReadSnapshot;
  writeSnapshot?: WriteSnapshot;
}

interface MemoryCatalogEntry {
  expiresAt: number;
  value: ResolvedGeminiVoiceCatalog;
}

const processCache = new Map<string, MemoryCatalogEntry>();

function cacheKey(apiKey: string): string {
  // Cache public catalog data per credential fingerprint. This keeps a valid
  // profile's in-memory result from masking another profile's auth failure,
  // while the raw API key never appears in memory keys or logs.
  const fingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  return `gemini:prebuilt:all-english:${fingerprint}`;
}

function isEntry(value: unknown): value is GeminiVoiceCatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const voice = value as Partial<GeminiVoiceCatalogEntry>;
  return isSafeGeminiVoiceId(voice.id)
    && typeof voice.displayName === 'string'
    && voice.type === 'prebuilt'
    && ['female', 'male', 'neutral', 'unknown'].includes(voice.gender ?? '')
    && ['low', 'medium', 'high', 'unknown'].includes(voice.pitch ?? '');
}

function normalizeSnapshot(value: unknown): GeminiVoiceCatalogSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Partial<GeminiVoiceCatalogSnapshot>;
  const fetchedAt = snapshot.fetchedAt;
  const catalogVersionValue = snapshot.catalogVersion;
  if (
    snapshot.version !== SNAPSHOT_VERSION
    || typeof catalogVersionValue !== 'string'
    || typeof fetchedAt !== 'number'
    || !Number.isFinite(fetchedAt)
    || !Array.isArray(snapshot.languageCodes)
    || !Array.isArray(snapshot.voices)
  ) return null;
  const voices = snapshot.voices.filter(isEntry);
  if (!voices.length) return null;
  const languageCodes = snapshot.languageCodes.filter((code): code is string => typeof code === 'string' && code.trim().length > 0);
  return {
    version: SNAPSHOT_VERSION,
    catalogVersion: catalogVersionValue,
    fetchedAt,
    languageCodes,
    voices,
  };
}

function catalogVersion(voices: readonly GeminiVoiceCatalogEntry[]): string {
  const canonical = voices
    .map((voice) => `${voice.id}\u0000${voice.displayName}\u0000${voice.languageCode ?? ''}\u0000${voice.type}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function toSnapshot(result: GeminiVoiceCatalogFetchResult): GeminiVoiceCatalogSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    catalogVersion: catalogVersion(result.voices),
    fetchedAt: result.fetchedAt,
    languageCodes: [...result.languageCodes],
    voices: result.voices,
  };
}

async function readPersistentSnapshot(): Promise<GeminiVoiceCatalogSnapshot | null> {
  const rows = await db
    .select({ valueJson: adminSettings.valueJson })
    .from(adminSettings)
    .where(eq(adminSettings.key, GEMINI_VOICE_CATALOG_SNAPSHOT_KEY))
    .limit(1) as Array<{ valueJson: unknown }>;
  if (!rows[0]) return null;
  const stored = rows[0].valueJson;
  let parsed: unknown = stored;
  if (typeof stored === 'string') {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  return normalizeSnapshot(parsed);
}

async function writePersistentSnapshot(snapshot: GeminiVoiceCatalogSnapshot): Promise<void> {
  const now = Date.now();
  await db
    .insert(adminSettings)
    .values({
      key: GEMINI_VOICE_CATALOG_SNAPSHOT_KEY,
      valueJson: JSON.stringify(snapshot) as never,
      source: 'system-cache',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: adminSettings.key,
      set: {
        valueJson: JSON.stringify(snapshot) as never,
        source: 'system-cache',
        updatedAt: now,
      },
    });
}

/** The old featured 30 are intentionally only the final offline fallback. */
export function getLegacyGeminiFeaturedVoiceFallback(): GeminiVoiceCatalogEntry[] {
  return CLOUD_TTS_ALL_VOICES.map((id) => ({
    id,
    displayName: id,
    languageCode: 'en-US',
    regionCode: null,
    accent: null,
    gender: CLOUD_TTS_FEMALE_VOICE_SET.has(id) ? 'female' : 'male',
    pitch: 'unknown',
    persona: null,
    context: null,
    description: null,
    type: 'prebuilt',
    model: null,
    expireTime: null,
  }));
}

function resolvedFromSnapshot(
  snapshot: GeminiVoiceCatalogSnapshot,
  source: 'cache' | 'snapshot',
  statusNotice?: GeminiVoiceCatalogStatusNotice,
): ResolvedGeminiVoiceCatalog {
  return {
    source,
    fetchedAt: snapshot.fetchedAt,
    catalogVersion: snapshot.catalogVersion,
    voices: snapshot.voices,
    languageCodes: snapshot.languageCodes,
    ...(statusNotice ? { statusNotice } : {}),
  };
}

function statusNoticeFor(error: unknown): GeminiVoiceCatalogStatusNotice {
  if (error instanceof GeminiVoiceCatalogApiError) {
    if (error.statusCode === 401) return { code: 'authentication', message: 'Gemini authentication failed. Check this profile?s API key.' };
    if (error.statusCode === 403) return { code: 'permission', message: 'Gemini denied access to the Voice Library for this API key.' };
    if (error.statusCode === 429) return { code: 'rate-limit', message: 'Gemini is rate-limiting Voice Library refreshes. Cached voices remain available.', ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}) };
  }
  return { code: 'unavailable', message: 'Gemini Voice Library refresh is temporarily unavailable. Cached voices remain available when possible.' };
}

/**
 * Resolves a catalog in the resilient order: fresh process cache, live API,
 * durable last-known-good snapshot, then the retired featured-30 fallback.
 */
export async function resolveGeminiPrebuiltVoiceCatalog(
  options: ResolveGeminiVoiceCatalogOptions,
): Promise<ResolvedGeminiVoiceCatalog> {
  const now = options.now ?? Date.now;
  // Voice retrieval is deliberately one all-English scope. Legacy locale
  // options are ignored so separate callers cannot fragment the catalog.
  const requestedLanguages: readonly string[] = [];
  const key = cacheKey(options.apiKey);
  const cached = processCache.get(key);
  if (cached && cached.expiresAt > now()) return { ...cached.value, source: 'cache' };

  const fetchCatalog = options.fetchCatalog ?? fetchGeminiPrebuiltVoiceCatalog;
  const readSnapshot = options.readSnapshot ?? readPersistentSnapshot;
  const writeSnapshot = options.writeSnapshot ?? writePersistentSnapshot;
  try {
    const live = await fetchCatalog({ apiKey: options.apiKey, languageCodes: requestedLanguages });
    const snapshot = toSnapshot(live);
    const resolved: ResolvedGeminiVoiceCatalog = {
      ...resolvedFromSnapshot(snapshot, 'snapshot'),
      source: 'live',
    };
    processCache.set(key, { expiresAt: now() + GEMINI_VOICE_CATALOG_CACHE_TTL_MS, value: resolved });
    try {
      await writeSnapshot(snapshot);
    } catch {
      // A live catalog remains safe to serve if durable cache persistence is briefly unavailable.
    }
    return resolved;
  } catch (error) {
    const statusNotice = statusNoticeFor(error);
    try {
      const snapshot = await readSnapshot();
      if (snapshot) {
        const resolved = resolvedFromSnapshot(snapshot, 'snapshot', statusNotice);
        processCache.set(key, { expiresAt: now() + Math.min(GEMINI_VOICE_CATALOG_CACHE_TTL_MS, 5 * 60 * 1_000), value: resolved });
        return resolved;
      }
    } catch {
      // Continue to the explicit legacy emergency fallback.
    }
    const voices = getLegacyGeminiFeaturedVoiceFallback();
    return {
      source: 'legacy-fallback',
      fetchedAt: now(),
      catalogVersion: catalogVersion(voices),
      voices,
      languageCodes: [...requestedLanguages],
      statusNotice,
    };
  }
}

/** Test-only isolation for the process cache; never use this in request handling. */
export function resetGeminiVoiceCatalogMemoryCacheForTests(): void {
  processCache.clear();
}
