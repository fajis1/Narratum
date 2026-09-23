import { isKokoroSafePronunciation } from './kokoro-pronunciation-policy';
import {
  normalizeDictionaryDefinition,
  shouldOmitDictionaryDefinition,
} from './dictionary-definition-policy';

export interface ForeignWordImportChange {
  word: string;
  pronunciation?: string;
  definition?: string | null;
}

type ScanWord = Record<string, unknown> & { word: string };

export interface ForeignWordScanTransfer {
  format: 'openreader-foreign-word-scan';
  version: 1;
  documentId: string;
  exportedAt: string;
  instructions: string;
  words: Array<{
    word: string;
    count: number | null;
    contexts: string[];
    currentPronunciation: string | null;
    currentDefinition: string | null;
    proposedPronunciation: string | null;
    proposedDefinition: string | null;
    omitDefinition: boolean;
  }>;
}

export function exportForeignWordScan(documentId: string, words: readonly ScanWord[]): ForeignWordScanTransfer {
  return {
    format: 'openreader-foreign-word-scan',
    version: 1,
    documentId,
    exportedAt: new Date().toISOString(),
    instructions: 'Edit proposedPronunciation and proposedDefinition. Leave null to keep the current value; set omitDefinition to true to clear a definition. Import into the same document after the scan finishes.',
    words: words.map((row) => ({
      word: row.word,
      count: typeof row.count === 'number' ? row.count : null,
      contexts: Array.isArray(row.contexts) ? row.contexts.filter((value): value is string => typeof value === 'string') : [],
      currentPronunciation: [row.userOverride, row.libraryPronunciation, row.geminiRecommendedPronunciation,
        ...(Array.isArray(row.pronunciations) ? row.pronunciations.map((choice) =>
          typeof choice === 'string' ? choice : choice && typeof choice === 'object' ? (choice as { phonetic?: unknown }).phonetic : null) : [])]
        .find((value): value is string => typeof value === 'string' && value !== '[OMIT]' && isKokoroSafePronunciation(row.word, value)) || null,
      currentDefinition: typeof row.definition === 'string' ? row.definition : null,
      proposedPronunciation: null,
      proposedDefinition: null,
      omitDefinition: false,
    })),
  };
}

export function parseForeignWordScanImport(value: unknown, documentId: string, allowedWords: ReadonlySet<string>): ForeignWordImportChange[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an OpenReader scan JSON object.');
  const input = value as Record<string, unknown>;
  if (input.format !== 'openreader-foreign-word-scan' || input.version !== 1) throw new Error('Unsupported scan JSON format or version.');
  if (input.documentId !== documentId) throw new Error('This scan JSON belongs to a different document.');
  if (!Array.isArray(input.words) || input.words.length > 20_000) throw new Error('The scan JSON must contain at most 20,000 words.');
  const seen = new Set<string>();
  const changes: ForeignWordImportChange[] = [];
  for (const raw of input.words) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each imported word must be an object.');
    const row = raw as Record<string, unknown>;
    const word = typeof row.word === 'string' ? row.word.normalize('NFC').trim() : '';
    if (!word || !allowedWords.has(word) || seen.has(word)) throw new Error(`Unknown or duplicate scan word: ${word || '(blank)'}.`);
    seen.add(word);
    const change: ForeignWordImportChange = { word };
    if (row.proposedPronunciation !== null && row.proposedPronunciation !== undefined) {
      if (typeof row.proposedPronunciation !== 'string' || !isKokoroSafePronunciation(word, row.proposedPronunciation)) {
        throw new Error(`Invalid Kokoro pronunciation for ${word}.`);
      }
      change.pronunciation = row.proposedPronunciation;
    }
    if (row.omitDefinition === true) {
      if (row.proposedDefinition !== null && row.proposedDefinition !== undefined) throw new Error(`Conflicting definition edits for ${word}.`);
      change.definition = null;
    } else if (row.proposedDefinition !== null && row.proposedDefinition !== undefined) {
      if (typeof row.proposedDefinition !== 'string' || shouldOmitDictionaryDefinition(row.proposedDefinition)) {
        throw new Error(`Invalid contextual definition for ${word}.`);
      }
      const definition = normalizeDictionaryDefinition(row.proposedDefinition);
      if (!definition) throw new Error(`Invalid contextual definition for ${word}.`);
      change.definition = definition;
    }
    if (change.pronunciation !== undefined || change.definition !== undefined) changes.push(change);
  }
  if (!changes.length) throw new Error('No proposed edits were found in the scan JSON.');
  return changes;
}
