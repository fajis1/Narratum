import { createHash } from 'node:crypto';
import {
  getKokoroPronunciationQualityWarnings,
  isKokoroSafePronunciation,
} from '@/lib/shared/kokoro-pronunciation-policy';

export const GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      term: {
        type: 'string',
        description: 'The exact term from the request.',
      },
      language: {
        type: 'string',
        enum: ['koine_greek', 'biblical_hebrew', 'other'],
      },
      pronunciations: {
        type: 'array',
        items: { type: 'string' },
        minItems: 0,
        maxItems: 5,
      },
      ocrFragment: {
        type: 'boolean',
        description: 'True only when supplied OCR evidence proves this is a damaged fragment, not a lexical term.',
      },
      definition: {
        type: ['string', 'null'],
        description: 'One concise contextual English meaning, never a list of alternative glosses or a function-word-only gloss.',
      },
      definitionOmitted: {
        type: 'boolean',
        description: 'True only when no useful contextual gloss should be spoken.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      needsReview: {
        type: 'boolean',
      },
    },
    required: [
      'term',
      'language',
      'pronunciations',
      'ocrFragment',
      'definition',
      'definitionOmitted',
      'confidence',
      'needsReview',
    ],
  },
} as const;

export interface GeminiForeignWordResult extends Record<string, unknown> {
  term: string;
}

export type GeminiForeignWordTerm = {
  term: string;
  contexts: string[];
  currentPronunciation: string | null;
  ocrSuspect?: boolean;
  ocrEvidence?: string[];
  latinTransliterationCandidate?: boolean;
};

export function isRejectedLatinTransliteration(
  term: GeminiForeignWordTerm,
  result: GeminiForeignWordResult | undefined,
): boolean {
  return term.latinTransliterationCandidate === true && result?.language === 'other';
}

/**
 * The foreign-word scanner is a lexical dictionary builder. It must not send
 * OCR-extracted multi-word phrases (or an accidental IPA value used as a key)
 * to Gemini as though they were single reusable dictionary terms.
 */
export function isUsableForeignWordCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const word = (value as { word?: unknown }).word;
  return typeof word === 'string'
    && Boolean(word.trim())
    && !/\s/u.test(word)
    && !/^\/.*\/$/u.test(word.trim());
}

export type GeminiPronunciationRepairRequest = GeminiForeignWordTerm & {
  acceptedPronunciations: string[];
  rejectedPronunciations: Array<{
    pronunciation: unknown;
    violations: string[];
  }>;
  choicesNeeded: number;
};

export function collectGeminiPronunciationRepairRequests(
  terms: readonly GeminiForeignWordTerm[],
  results: readonly GeminiForeignWordResult[],
): GeminiPronunciationRepairRequest[] {
  const resultsByTerm = new Map(results.map((result) => [result.term, result]));
  return terms.flatMap((term) => {
    const result = resultsByTerm.get(term.term);
    if (term.ocrSuspect === true && result?.ocrFragment === true) return [];
    if (isRejectedLatinTransliteration(term, result)) return [];
    const pronunciations = Array.isArray(result?.pronunciations) ? result.pronunciations : [];
    const acceptedPronunciations = pronunciations
      .filter((pronunciation): pronunciation is string => (
        isKokoroSafePronunciation(term.term, pronunciation)
      ))
      .filter((pronunciation, index, all) => all.indexOf(pronunciation) === index);
    const rejectedPronunciations = pronunciations.flatMap((pronunciation) => {
      const violations = getKokoroPronunciationQualityWarnings(term.term, pronunciation);
      return violations.length > 0 ? [{ pronunciation, violations }] : [];
    });
    if (!result) {
      rejectedPronunciations.push({
        pronunciation: null,
        violations: ['Gemini omitted this requested term.'],
      });
    } else if (pronunciations.length === 0) {
      rejectedPronunciations.push({
        pronunciation: null,
        violations: ['Gemini returned no pronunciation choices for this term.'],
      });
    }
    const expectedChoices = term.currentPronunciation ? 1 : 5;
    const choicesNeeded = Math.max(0, expectedChoices - acceptedPronunciations.length);
    if (choicesNeeded === 0) return [];
    return [{
      ...term,
      acceptedPronunciations,
      rejectedPronunciations,
      choicesNeeded,
    }];
  });
}

export function mergeGeminiPronunciationRepairResults(
  initialResults: readonly GeminiForeignWordResult[],
  repairResults: readonly GeminiForeignWordResult[],
): GeminiForeignWordResult[] {
  const merged = new Map(initialResults.map((result) => [result.term, { ...result }]));
  for (const repair of repairResults) {
    const initial = merged.get(repair.term);
    const pronunciations = [
      ...(Array.isArray(initial?.pronunciations) ? initial.pronunciations : []),
      ...(Array.isArray(repair.pronunciations) ? repair.pronunciations : []),
    ].filter((pronunciation): pronunciation is string => (
      isKokoroSafePronunciation(repair.term, pronunciation)
    )).filter((pronunciation, index, all) => all.indexOf(pronunciation) === index).slice(0, 5);
    merged.set(repair.term, {
      ...initial,
      ...repair,
      pronunciations,
    });
  }
  return [...merged.values()];
}

export interface ForeignWordScanJob extends Record<string, unknown> {
  id: string;
  userId: string;
  documentId?: string;
  status?: string;
  updatedAt?: number;
}

function parseScanJob(value: unknown): ForeignWordScanJob | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof (parsed as { id?: unknown }).id !== 'string'
      || typeof (parsed as { userId?: unknown }).userId !== 'string'
    ) {
      return null;
    }
    return parsed as ForeignWordScanJob;
  } catch {
    return null;
  }
}

function isActiveScan(job: ForeignWordScanJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function newestFirst(a: ForeignWordScanJob, b: ForeignWordScanJob): number {
  return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
}

export function findLatestForeignWordScanJob(
  values: readonly unknown[],
  userId: string,
  documentId: string,
): ForeignWordScanJob | null {
  const userJobs = values
    .map(parseScanJob)
    .filter((job): job is ForeignWordScanJob => job?.userId === userId);
  const documentJobs = userJobs.filter((job) => job.documentId === documentId);
  const activeDocumentJobs = documentJobs.filter(isActiveScan).sort(newestFirst);
  if (activeDocumentJobs[0]) return activeDocumentJobs[0];
  documentJobs.sort(newestFirst);
  if (documentJobs[0]) return documentJobs[0];

  // Jobs created before document IDs were persisted can only be reattached
  // safely when this user has exactly one active legacy scan.
  const activeLegacyJobs = userJobs
    .filter((job) => !job.documentId && isActiveScan(job))
    .sort(newestFirst);
  return activeLegacyJobs.length === 1 ? activeLegacyJobs[0] : null;
}

export const FOREIGN_WORD_CANDIDATE_CACHE_VERSION = 11;

export function foreignWordCandidateCacheKey(input: {
  userId: string;
  documentId: string;
  mode: string;
  target: number;
  query: unknown;
}): string {
  const scopeHash = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex');
  return `foreign_word_candidates:v${FOREIGN_WORD_CANDIDATE_CACHE_VERSION}:${scopeHash}`;
}

export function parseForeignWordCandidateCache(value: unknown): unknown[] | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (
      !parsed
      || typeof parsed !== 'object'
      || (parsed as { version?: unknown }).version !== FOREIGN_WORD_CANDIDATE_CACHE_VERSION
      || !Array.isArray((parsed as { words?: unknown }).words)
    ) {
      return null;
    }
    return (parsed as { words: unknown[] }).words;
  } catch {
    return null;
  }
}

export class GeminiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiHttpError';
  }
}

function sanitizeGeminiErrorDetail(value: unknown, secrets: string[]): string {
  const raw = typeof value === 'string' && value.trim()
    ? value.trim()
    : 'No Gemini error detail';
  let sanitized = raw
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ');
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.replaceAll(secret, '[REDACTED]');
  }
  return sanitized.slice(0, 1000);
}

export function createGeminiHttpError(
  status: number,
  payload: unknown,
  secrets: string[] = [],
): GeminiHttpError {
  const detail = payload
    && typeof payload === 'object'
    && 'error' in payload
    && payload.error
    && typeof payload.error === 'object'
    && 'message' in payload.error
    ? payload.error.message
    : undefined;
  return new GeminiHttpError(
    status,
    `Gemini request failed (HTTP ${status}): ${sanitizeGeminiErrorDetail(detail, secrets)}`,
  );
}

export function parseGeminiForeignWordResults(text: string): {
  results: GeminiForeignWordResult[];
  repaired: boolean;
} {
  let parsed: unknown;
  let repaired = false;
  try {
    parsed = JSON.parse(text);
  } catch (jsonError) {
    // A token-limited array can still contain complete leading result objects.
    const lastCompleteObject = text.lastIndexOf('}');
    if (lastCompleteObject < 1 || !text.slice(0, lastCompleteObject + 1).trimStart().startsWith('[')) {
      throw jsonError;
    }
    parsed = JSON.parse(`${text.slice(0, lastCompleteObject + 1)}]`);
    repaired = true;
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini returned an invalid pronunciation result: expected a JSON array.');
  }

  const results = parsed.filter((item): item is GeminiForeignWordResult => (
    item !== null
    && typeof item === 'object'
    && !Array.isArray(item)
    && typeof (item as { term?: unknown }).term === 'string'
  ));
  return { results, repaired };
}
