import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { serverLogger } from '@/lib/server/logger';

/** 30 days in milliseconds */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

export interface SefariaLexiconEntry {
  headword: string;
  lexicon: string;              // e.g. "BDB Augmented Strong", "Jastrow Dictionary", "LSJ"
  strongsNumber: string | null; // e.g. "H7965" or "G3056"
  transliteration: string | null;
  pronunciation: string | null; // Sefaria's own phonetic hint e.g. "shaw-lome'"
  morphology: string | null;    // e.g. "n-m", "v-qal"
  definitions: string[];        // primary definitions, ordered
  source: 'sefaria' | 'perseus';
}

interface CachedEntry {
  entry: SefariaLexiconEntry | null;
  cachedAt: number;
}

function cacheKey(word: string): string {
  // Use base64 of the word to safely store Unicode in a plain key
  const encoded = Buffer.from(word, 'utf8').toString('base64url');
  return `sefaria_cache:${encoded}`;
}

async function readCache(word: string): Promise<SefariaLexiconEntry | null | undefined> {
  try {
    const key = cacheKey(word);
    const rows = await db.select({ valueJson: adminSettings.valueJson })
      .from(adminSettings)
      .where(eq(adminSettings.key, key))
      .limit(1);
    if (!rows[0]?.valueJson) return undefined;
    const parsed = typeof rows[0].valueJson === 'string'
      ? JSON.parse(rows[0].valueJson) as CachedEntry
      : rows[0].valueJson as CachedEntry;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (Date.now() - (parsed.cachedAt || 0) > CACHE_TTL_MS) return undefined;
    return parsed.entry;
  } catch {
    return undefined;
  }
}

async function writeCache(word: string, entry: SefariaLexiconEntry | null): Promise<void> {
  try {
    const key = cacheKey(word);
    const value: CachedEntry = { entry, cachedAt: Date.now() };
    await db.insert(adminSettings).values({
      key,
      valueJson: JSON.stringify(value),
      source: 'runtime',
    }).onConflictDoUpdate({
      target: adminSettings.key,
      set: { valueJson: JSON.stringify(value), updatedAt: Date.now() },
    });
  } catch {
    // Cache write failures are non-fatal
  }
}

/**
 * Fetch a lexicon entry from Sefaria's /api/words/ endpoint.
 * Returns null if not found or on error.
 */
async function fetchFromSefaria(
  word: string,
  language: 'koine_greek' | 'biblical_hebrew',
): Promise<SefariaLexiconEntry | null> {
  const encoded = encodeURIComponent(word);
  const url = `https://www.sefaria.org/api/words/${encoded}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'OpenReader/1.0 (biblical-lexicon-lookup)' },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json() as unknown[];
    if (!Array.isArray(data) || data.length === 0) return null;

    // Prefer academic lexicons in priority order
    const preferredLexicons = language === 'biblical_hebrew'
      ? ['BDB Augmented Strong', 'BDB', 'Klein Dictionary', 'Jastrow Dictionary']
      : ['LSJ', 'Liddell-Scott', 'Middle Liddell', 'Strong Greek'];

    const entry = preferredLexicons.reduce<unknown | null>((found, lexName) => {
      if (found) return found;
      return (data as Array<Record<string, unknown>>).find((e) =>
        typeof e.parent_lexicon === 'string' && e.parent_lexicon.includes(lexName.split(' ')[0]),
      ) ?? null;
    }, null) ?? data[0];

    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;

    const content = (e.content && typeof e.content === 'object'
      ? e.content
      : {}) as Record<string, unknown>;
    const senses = Array.isArray(content.senses) ? content.senses as Array<Record<string, unknown>> : [];
    const definitions = senses
      .map((s) => (typeof s.definition === 'string' ? s.definition : null))
      .filter((d): d is string => Boolean(d))
      .slice(0, 3);

    return {
      headword: typeof e.headword === 'string' ? e.headword : word,
      lexicon: typeof e.parent_lexicon === 'string' ? e.parent_lexicon : 'Sefaria',
      strongsNumber: typeof e.strong_number === 'string' ? e.strong_number : null,
      transliteration: typeof e.transliteration === 'string' ? e.transliteration : null,
      pronunciation: typeof e.pronunciation === 'string' ? e.pronunciation : null,
      morphology: typeof content.morphology === 'string' ? content.morphology : null,
      definitions,
      source: 'sefaria',
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Fetch Greek morphology from Perseus Alpheios Morphology API.
 * Returns null if not found or on error.
 */
async function fetchFromPerseus(word: string): Promise<SefariaLexiconEntry | null> {
  // Perseus prefers stripped diacritics in some endpoints; try the Unicode form
  const encoded = encodeURIComponent(word);
  const url = `http://services.perseus.tufts.edu/exist/restxq/alpheios/morphology/Greek/${encoded}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'OpenReader/1.0 (biblical-lexicon-lookup)' },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    const data = await response.json() as unknown;
    if (!data || typeof data !== 'object') return null;

    // Perseus Alpheios response: { RDF: { Annotation: { Body: { rest: { entry: { dict: { hdwd, pofs, ... } } } } } } }
    // Shape varies; extract what we can defensively
    const body = (data as Record<string, unknown>)?.RDF;
    if (!body || typeof body !== 'object') return null;

    const annotation = (body as Record<string, unknown>)?.Annotation;
    const entryBody = (annotation as Record<string, unknown>)?.Body;
    const rest = (entryBody as Record<string, unknown>)?.rest;
    const entryObj = (rest as Record<string, unknown>)?.entry;
    const dict = (entryObj as Record<string, unknown>)?.dict;

    if (!dict || typeof dict !== 'object') return null;
    const d = dict as Record<string, unknown>;

    const hdwd = typeof d.hdwd === 'string' ? d.hdwd
      : (d.hdwd && typeof d.hdwd === 'object' ? (d.hdwd as Record<string, unknown>)?.$ : null);
    const pofs = typeof d.pofs === 'string' ? d.pofs
      : (d.pofs && typeof d.pofs === 'object' ? (d.pofs as Record<string, unknown>)?.$ : null);

    if (!hdwd) return null;

    return {
      headword: String(hdwd),
      lexicon: 'Perseus Morpheus',
      strongsNumber: null,
      transliteration: null,
      pronunciation: null,
      morphology: pofs ? String(pofs) : null,
      definitions: [],
      source: 'perseus',
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Look up a word in Sefaria (and Perseus as Greek fallback).
 * Results are cached in adminSettings for 30 days.
 * Returns null (graceful no-op) if not found or on any error.
 */
export async function fetchLexiconEntry(
  word: string,
  language: 'koine_greek' | 'biblical_hebrew',
): Promise<SefariaLexiconEntry | null> {
  // Cache check (undefined = miss/expired, null = confirmed not found)
  const cached = await readCache(word);
  if (cached !== undefined) return cached;

  try {
    const entry = await fetchFromSefaria(word, language);
    if (entry) {
      await writeCache(word, entry);
      return entry;
    }

    // Greek fallback: try Perseus if Sefaria returned nothing
    if (language === 'koine_greek') {
      const perseusEntry = await fetchFromPerseus(word);
      await writeCache(word, perseusEntry);
      return perseusEntry;
    }

    await writeCache(word, null);
    return null;
  } catch (error) {
    serverLogger.debug({
      event: 'sefaria.lexicon.error',
      word,
      language,
      error: error instanceof Error ? error.message : String(error),
    }, 'Lexicon lookup failed (non-fatal)');
    return null;
  }
}

/**
 * Fetch lexicon entries for multiple words in parallel (max 5 concurrent).
 * Always resolves — individual failures return null.
 */
export async function fetchLexiconEntries(
  words: Array<{ word: string; language: 'koine_greek' | 'biblical_hebrew' | 'other' }>,
): Promise<Map<string, SefariaLexiconEntry | null>> {
  const biblicalWords = words.filter(
    (w): w is { word: string; language: 'koine_greek' | 'biblical_hebrew' } =>
      w.language === 'koine_greek' || w.language === 'biblical_hebrew',
  );

  const results = new Map<string, SefariaLexiconEntry | null>();

  // Process in batches of 5 to avoid hammering Sefaria
  const CONCURRENCY = 5;
  for (let i = 0; i < biblicalWords.length; i += CONCURRENCY) {
    const batch = biblicalWords.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ({ word, language }) => {
        const entry = await fetchLexiconEntry(word, language).catch(() => null);
        return { word, entry };
      }),
    );
    for (const { word, entry } of batchResults) {
      results.set(word, entry);
    }
  }

  return results;
}
