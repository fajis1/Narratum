import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { documentSettings } from '@/db/schema';
import type {
  SmartAudioBookLexicon,
  SmartAudioBookLexiconEntry,
} from '@/types/document-settings';
import type { SmartAudioProfile } from '@/types/client';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import {
  buildKokoroPronunciationInstructions,
  isKokoroCompatiblePronunciation,
} from '@/lib/shared/kokoro-pronunciation-policy';
import { resolvePronunciationAiModel } from '@/lib/shared/smart-audio-models';
import {
  normalizeGeminiTokenUsage,
  type GeminiTokenUsage,
} from '@/lib/server/smart-audio/gemini-usage';
import { fetchGeminiWithRateLimitFallback } from '@/lib/server/smart-audio/gemini-failover';
import {
  normalizeDictionaryDefinition,
  shouldOmitDictionaryDefinition,
} from '@/lib/shared/dictionary-definition-policy';
import { serverLogger } from '@/lib/server/logger';
import { isContextualDefinitionLanguage } from '@/lib/shared/foreign-word-language';

const FOREIGN_WORD = /[\u0370-\u03ff\u1f00-\u1fff\u0590-\u05ff][\u0300-\u036f\u0370-\u03ff\u1f00-\u1fff\u0590-\u05ff]*/gu;
const FOREIGN_WORD_BEFORE = /[\u0370-\u03ff\u1f00-\u1fff\u0590-\u05ff][\u0300-\u036f\u0370-\u03ff\u1f00-\u1fff\u0590-\u05ff]*[\p{P}\p{S}\p{Z}\s]*$/u;
const FOREIGN_WORD_AFTER = /^[\p{P}\p{S}\p{Z}\s]*[\u0370-\u03ff\u1f00-\u1fff\u0590-\u05ff]/u;
const FOREIGN_TERM_CHARACTER_CLASS = String.raw`\p{L}\p{M}\p{N}`;
const GREEK = /[\u0370-\u03ff\u1f00-\u1fff]/u;
const HEBREW = /[\u0590-\u05ff]/u;

export type SmartAudioTermCandidate = {
  term: string;
  contexts: string[];
  pronunciation?: string;
  definition?: string;
};

function parseStoredSettings(value: unknown) {
  if (typeof value === 'string') {
    try {
      return mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, JSON.parse(value));
    } catch {
      return mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, null);
    }
  }
  return mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, value);
}

function serializeForDb(value: Record<string, unknown>): Record<string, unknown> | string {
  return process.env.POSTGRES_URL ? value : JSON.stringify(value);
}

export async function readBookLexicon(
  userId: string,
  documentId: string,
): Promise<SmartAudioBookLexicon | null> {
  const rows = await db
    .select({ dataJson: documentSettings.dataJson })
    .from(documentSettings)
    .where(and(
      eq(documentSettings.userId, userId),
      eq(documentSettings.documentId, documentId),
    ))
    .limit(1);
  return parseStoredSettings(rows[0]?.dataJson).smartAudioLexicon ?? null;
}

export async function writeBookLexicon(
  userId: string,
  documentId: string,
  lexicon: SmartAudioBookLexicon,
): Promise<void> {
  const now = Date.now();
  const initialPayload = serializeForDb({
    ...DEFAULT_DOCUMENT_SETTINGS,
    smartAudioLexicon: lexicon,
  } as unknown as Record<string, unknown>);
  const serializedLexicon = JSON.stringify(lexicon);
  // Merge only the server-owned field inside the database. This avoids a
  // read/modify/write race with client document-setting saves and leaves the
  // client edit clock unchanged on conflict.
  const mergedDataJson = process.env.POSTGRES_URL
    ? sql`jsonb_set(coalesce(${documentSettings.dataJson}, '{}'::jsonb), '{smartAudioLexicon}', ${serializedLexicon}::jsonb, true)`
    : sql`json_set(coalesce(${documentSettings.dataJson}, '{}'), '$.smartAudioLexicon', json(${serializedLexicon}))`;

  await db.insert(documentSettings).values({
    documentId,
    userId,
    dataJson: initialPayload as never,
    clientUpdatedAtMs: 0,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [documentSettings.documentId, documentSettings.userId],
    set: {
      dataJson: mergedDataJson as never,
      updatedAt: now,
    },
  });
}

function contextAround(text: string, start: number, end: number): string {
  const leftBoundary = Math.max(
    text.lastIndexOf('.', start - 1),
    text.lastIndexOf('!', start - 1),
    text.lastIndexOf('?', start - 1),
    text.lastIndexOf('\n', start - 1),
  );
  const rightCandidates = [
    text.indexOf('.', end),
    text.indexOf('!', end),
    text.indexOf('?', end),
    text.indexOf('\n', end),
  ].filter((value) => value >= 0);
  const rightBoundary = rightCandidates.length > 0 ? Math.min(...rightCandidates) + 1 : text.length;
  return text.slice(Math.max(0, leftBoundary + 1), Math.min(text.length, rightBoundary)).trim().slice(0, 320);
}

export function collectSmartAudioTermCandidates(
  texts: readonly string[],
  knownPronunciations: Record<string, string> = {},
  knownDefinitions: Record<string, string> = {},
): SmartAudioTermCandidate[] {
  const candidates = new Map<string, SmartAudioTermCandidate>();
  const normalizedKnown = new Map(
    Object.entries(knownPronunciations).map(([term, pronunciation]) => [term.normalize('NFC'), pronunciation]),
  );

  for (const originalText of texts) {
    const text = originalText.normalize('NFC');
    for (const match of text.matchAll(FOREIGN_WORD)) {
      const term = match[0].normalize('NFC');
      if (term.length < 2 || match.index == null) continue;
      const before = text.slice(0, match.index);
      const after = text.slice(match.index + match[0].length);
      if (FOREIGN_WORD_BEFORE.test(before) || FOREIGN_WORD_AFTER.test(after)) continue;
      const key = term;
      const existing = candidates.get(key) || {
        term,
        contexts: [],
        pronunciation: normalizedKnown.get(key),
        definition: knownDefinitions[term],
      };
      const context = contextAround(text, match.index, match.index + term.length);
      if (context && !existing.contexts.includes(context) && existing.contexts.length < 2) {
        existing.contexts.push(context);
      }
      candidates.set(key, existing);
    }
  }
  return [...candidates.values()];
}

function parseGeminiJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(cleaned);
}

function normalizePronunciation(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const wrapped = trimmed.startsWith('/') && trimmed.endsWith('/') ? trimmed : `/${trimmed.replace(/^\/|\/$/g, '')}/`;
  return isKokoroCompatiblePronunciation(wrapped) ? wrapped : null;
}

export async function resolveSmartAudioBookLexicon(input: {
  profile: SmartAudioProfile;
  candidates: SmartAudioTermCandidate[];
  existing?: SmartAudioBookLexicon | null;
  onProgress?: (lexicon: SmartAudioBookLexicon) => Promise<void>;
  onUsage?: (usage: {
    model: string;
    batch: number;
    tokens: GeminiTokenUsage;
  }) => void;
}): Promise<SmartAudioBookLexicon> {
  const candidateTerms = new Set(input.candidates.map((candidate) => candidate.term));
  const entries: Record<string, SmartAudioBookLexiconEntry> = Object.fromEntries(
    Object.entries(input.existing?.entries || {})
      .filter(([term, entry]) => candidateTerms.has(term) || entry.approvedRepair === true
        // The auto-scan collects biblical-script candidates. Keep the broader
        // language readings already resolved by a document pre-scan.
        || (isContextualDefinitionLanguage(entry.detectedLanguage) && entry.language === 'other'
          && isKokoroCompatiblePronunciation(entry.pronunciation) && (Boolean(entry.definition) || entry.definitionOmitted === true)))
      .map(([term, entry]) => {
        const definition = normalizeDictionaryDefinition(entry.definition);
        if (definition === entry.definition) return [term, entry];
        return [term, definition === null
          ? {
            ...entry,
            definition: null,
            definitionOmitted: true,
            needsReview: false,
          }
          : {
            ...entry,
            definition,
            definitionOmitted: false,
          }];
      }),
  );
  // A valid global or personal pronunciation is already resolved for this
  // document, even if an earlier book-lexicon write was interrupted. Seed it
  // before calculating unresolved work so Gemini never regenerates it.
  for (const candidate of input.candidates) {
    if (entries[candidate.term]) {
      if (!entries[candidate.term].definition && candidate.definition) {
        entries[candidate.term].definition = candidate.definition;
        entries[candidate.term].definitionOmitted = false;
      }
      continue;
    }
    if (!candidate.pronunciation) continue;
    const pronunciation = normalizePronunciation(candidate.pronunciation);
    if (!pronunciation) continue;
    entries[candidate.term] = {
      term: candidate.term,
      pronunciation,
      definition: null,
      language: HEBREW.test(candidate.term)
        ? 'biblical_hebrew'
        : GREEK.test(candidate.term)
          ? 'koine_greek'
          : 'other',
      context: candidate.contexts[0],
      definitionOmitted: false,
    };
    if (candidate.definition) entries[candidate.term].definition = candidate.definition;
  }
  const unresolved = input.candidates.filter((candidate) => {
    const current = entries[candidate.term];
    return !current?.pronunciation || (!current.definition && current.definitionOmitted !== true);
  });

  // A complete global/local library must be usable without requiring a
  // Gemini key. Only validate the key and model when generation is needed.
  if (unresolved.length === 0) {
    const model = resolvePronunciationAiModel(input.profile);
    return {
      schemaVersion: 1,
      status: 'complete',
      definitionScanComplete: true,
      profileId: input.profile.id,
      pronunciationModel: model,
      scannedAt: Date.now(),
      entries,
    };
  }
  const apiKey = (input.profile.geminiApiKey || '').trim();
  if (!apiKey) throw new Error('Gemini API key is not configured for the selected Smart Audio profile.');
  const model = resolvePronunciationAiModel(input.profile);
  let effectiveModel = model;

  for (let offset = 0; offset < unresolved.length; offset += 15) {
    const batch = unresolved.slice(offset, offset + 15);
    const prompt = `${buildKokoroPronunciationInstructions(input.profile)}

Create an audiobook lexicon for the following isolated Koine Greek or Biblical Hebrew terms.
Use the supplied context to choose a short contextual English gloss of one to four words.
Return exactly one meaning, never a comma-, slash-, semicolon-, "and"-, or "or"-separated list of synonyms or alternatives.
Do not return a definition that consists only of a common function or connecting word such as "the", "or", "of", "off", or "like"; omit it instead.
If the context already states the term's definition, return that same concise gloss; OpenReader suppresses duplicate insertion locally.
If a term is not Koine Greek or Biblical Hebrew, set definition to null.
If a token is an OCR fragment, an unidentifiable fragment, or an inflected form with no reliable contextual English gloss, return definition as null and definitionOmitted as true. Never return placeholder prose such as "Fragment or inflected form" as the definition.
Otherwise return a useful contextual definition and set definitionOmitted to false.
If a pronunciation is supplied, preserve it exactly. Otherwise provide five Kokoro-compatible IPA choices and put the best first.
Return JSON only in this shape:
{"items":[{"term":"λόγος","language":"koine_greek","pronunciations":["/pron1/","/pron2/","/pron3/","/pron4/","/pron5/"],"definition":"word","definitionOmitted":false,"confidence":0.95,"needsReview":false}]}

Terms:
${JSON.stringify(batch)}`;

    const { response, usedModel } = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: apiKey,
      backupApiKey: input.profile.backupGeminiApiKey,
      requestedModel: model,
      request: (requestApiKey, requestModel) => fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestModel || model)}:generateContent?key=${encodeURIComponent(requestApiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        },
      ),
    });
    effectiveModel = usedModel || model;
    if (!response.ok) {
      const error = new Error(`Gemini lexicon request failed (HTTP ${response.status}).`) as Error & {
        status?: number;
        response?: { status: number; headers: Headers };
      };
      error.status = response.status;
      error.response = { status: response.status, headers: response.headers };
      throw error;
    }
    const data = await response.json();
    input.onUsage?.({
      model: effectiveModel,
      batch: Math.floor(offset / 15) + 1,
      tokens: normalizeGeminiTokenUsage(data?.usageMetadata),
    });
    const generatedText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!generatedText) throw new Error('Gemini returned no lexicon results.');
    const parsed = parseGeminiJson(generatedText) as { items?: unknown[] };
    if (!Array.isArray(parsed.items)) throw new Error('Gemini returned an invalid lexicon result.');

    for (const rawItem of parsed.items) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const item = rawItem as Record<string, unknown>;
      const term = typeof item.term === 'string' ? item.term.normalize('NFC').trim() : '';
      const candidate = batch.find((entry) => entry.term === term);
      if (!candidate) continue;
      const generatedPronunciations = Array.isArray(item.pronunciations)
        ? item.pronunciations.map(normalizePronunciation).filter((value): value is string => Boolean(value))
        : [];
      const remembered = entries[term]?.approvedRepair ? entries[term] : undefined;
      const pronunciation = normalizePronunciation(remembered?.pronunciation) || normalizePronunciation(candidate.pronunciation) || generatedPronunciations[0];
      if (!pronunciation) continue;
      const language = item.language === 'biblical_hebrew'
        ? 'biblical_hebrew'
        : item.language === 'koine_greek'
          ? 'koine_greek'
          : item.language === 'other'
            ? 'other'
          : HEBREW.test(term)
            ? 'biblical_hebrew'
            : GREEK.test(term)
              ? 'koine_greek'
              : 'other';
      const definitionOmitted = item.definitionOmitted === true
        || shouldOmitDictionaryDefinition(item.definition);
      entries[term] = {
        ...(remembered ? { approvedRepair: true } : {}),
        term,
        pronunciation,
        definition: definitionOmitted ? null : normalizeDictionaryDefinition(item.definition),
        definitionOmitted,
        language,
        context: candidate.contexts[0],
        confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : undefined,
        needsReview: item.needsReview === true,
      };
    }

    if (input.onProgress) {
      await input.onProgress({
        schemaVersion: 1,
        status: 'partial',
        definitionScanComplete: false,
        profileId: input.profile.id,
        pronunciationModel: effectiveModel,
        scannedAt: Date.now(),
        entries,
      });
    }
  }

  const incomplete = input.candidates.filter((candidate) => {
    const entry = entries[candidate.term];
    return !entry?.pronunciation || (
      entry.language !== 'other'
      && !entry.definition
      && entry.definitionOmitted !== true
    );
  });
  if (incomplete.length > 0) {
    serverLogger.warn({
      event: 'smart_audio.book_lexicon.incomplete',
      incompleteTerms: incomplete
        .slice(0, 10)
        .map((candidate) => candidate.term)
        .join(', '),
      incompleteCount: incomplete.length,
    }, 'Gemini did not resolve all pronunciation and definition defaults; proceeding with resolved entries.');
  }

  return {
    schemaVersion: 1,
    status: 'complete',
    definitionScanComplete: true,
    profileId: input.profile.id,
    pronunciationModel: effectiveModel,
    scannedAt: Date.now(),
    entries,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nearbyTextAlreadyHasDefinition(
  text: string,
  offset: number,
  termLength: number,
  definition: string,
): boolean {
  const sentenceEndCandidates = [
    text.indexOf('.', offset + termLength),
    text.indexOf('!', offset + termLength),
    text.indexOf('?', offset + termLength),
    text.indexOf('\n', offset + termLength),
    offset + termLength + 140,
  ].filter((candidate) => candidate >= 0);
  const sentenceEnd = Math.min(...sentenceEndCandidates, text.length);
  const followingText = text.slice(offset + termLength, sentenceEnd);
  const definitionWords = definition
    .normalize('NFKC')
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (definitionWords.length === 0) return false;
  const definitionPattern = definitionWords.map(escapeRegExp).join(String.raw`[^\p{L}\p{N}]+`);
  const appositiveDefinition = new RegExp(
    String.raw`^\s*(?:(?:[,;:–—-]|\()\s*(?:(?:meaning|means|defined\s+as|translated\s+as)\s+)?|(?:meaning|means|defined\s+as|translated\s+as)\s+)${definitionPattern}(?![\p{L}\p{N}])`,
    'iu',
  );
  return appositiveDefinition.test(followingText);
}

export function enrichTextFromBookLexicon(
  text: string,
  lexicon: SmartAudioBookLexicon | null | undefined,
  options: {
    includeDefinitions: boolean;
    pronunciationOverrides?: Record<string, string>;
  },
): string {
  if (!lexicon || Object.keys(lexicon.entries).length === 0) return text;
  const enriched = text.normalize('NFC');
  const entries = Object.values(lexicon.entries).sort((a, b) => b.term.length - a.term.length);
  const entriesByTerm = new Map(entries.map((entry) => [entry.term, entry]));
  const definedTerms = new Set<string>();
  const pattern = new RegExp(
    `(?<!\\[)(?<![${FOREIGN_TERM_CHARACTER_CLASS}])(?:${entries.map((entry) => escapeRegExp(entry.term)).join('|')})(?![${FOREIGN_TERM_CHARACTER_CLASS}])(?!\\]\\()`,
    'gu',
  );
  return enriched.replace(pattern, (term, offset: number) => {
    const entry = entriesByTerm.get(term);
    if (!entry) return term;
    const definition = normalizeDictionaryDefinition(entry.definition);
    const beforeRaw = enriched.slice(0, offset);
    const afterRaw = enriched.slice(offset + term.length);
    // Strip HTML tags so that formatting like <i> or <span> doesn't hide adjacent foreign words
    const before = beforeRaw.replace(/<[^>]+>/g, ' ');
    const after = afterRaw.replace(/<[^>]+>/g, ' ');
    const isIsolated = !FOREIGN_WORD_BEFORE.test(before) && !FOREIGN_WORD_AFTER.test(after);
    const definitionAlreadyPresent = Boolean(
      definition
      && nearbyTextAlreadyHasDefinition(enriched, offset, term.length, definition),
    );
    if (definitionAlreadyPresent) definedTerms.add(term);
    const spokenDefinition = options.includeDefinitions
      && isIsolated
      && definition
      && !definitionAlreadyPresent
      && !definedTerms.has(term)
      ? `, ${definition},`
      : '';
    if (spokenDefinition) definedTerms.add(term);
    const pronunciation = options.pronunciationOverrides?.[term] || entry.pronunciation;
    return `[${term}](${pronunciation})${spokenDefinition}`;
  });
}

export function isCompleteScholarScanScope(input: {
  mode: string;
  target: number;
  query?: string | null;
}): boolean {
  return input.target >= 100
    && !input.query
    && (input.mode === 'all_foreign' || input.mode === 'greek_hebrew');
}

export function selectPronunciationsForText(
  text: string,
  pronunciations: Record<string, string>,
): Record<string, string> {
  const normalizedText = text.normalize('NFC');
  return Object.fromEntries(
    Object.entries(pronunciations).filter(([term]) => normalizedText.includes(term.normalize('NFC'))),
  );
}

export function pronunciationsFromBookLexicon(
  lexicon: SmartAudioBookLexicon | null | undefined,
): Record<string, string> {
  if (!lexicon) return {};
  return Object.fromEntries(
    Object.values(lexicon.entries)
      .filter((entry) => isKokoroCompatiblePronunciation(entry.pronunciation))
      .map((entry) => [entry.term, entry.pronunciation]),
  );
}
