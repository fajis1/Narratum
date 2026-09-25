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
  version: 2;
  documentId: string;
  exportedAt: string;
  instructions: string;
  words: Array<{
    word: string;
    count: number | null;
    contexts: string[];
    occurrences: Array<Record<string, unknown>>;
    editorialSpellings: string[];
    ocrEvidence: string[];
    sourceStatus: string;
    sourceOutcome: string | null;
    qualityFlags: string[];
    pronunciationSource: string | null;
    currentPronunciation: string | null;
    currentDefinition: string | null;
    proposedPronunciation: string | null;
    proposedDefinition: string | null;
    omitDefinition: boolean;
    importWarning?: string | null;
  }>;
}

export interface ExportForeignWordScanOptions {
  compactForAi?: boolean;
  partIndex?: number;
  totalParts?: number;
  sanitizeStopWords?: boolean;
}

export interface ForeignWordScanBatch {
  filename: string;
  partIndex: number;
  totalParts: number;
  wordCount: number;
  payload: ForeignWordScanTransfer;
}

export function exportForeignWordScan(
  documentId: string,
  words: readonly ScanWord[],
  options?: ExportForeignWordScanOptions,
): ForeignWordScanTransfer {
  const isBatch = typeof options?.partIndex === 'number' && typeof options?.totalParts === 'number';
  const batchPrefix = isBatch ? `Batch ${options!.partIndex} of ${options!.totalParts} (${words.length} words). ` : '';
  const compactNotice = options?.compactForAi ? ' Compact AI prompt format (internal bounding-box coordinates omitted).' : '';

  return {
    format: 'openreader-foreign-word-scan',
    version: 2,
    documentId,
    exportedAt: new Date().toISOString(),
    instructions: `${batchPrefix}Read sourceStatus, qualityFlags, and occurrences before proposing edits. Edit proposedPronunciation and proposedDefinition only for a verified complete word. Leave null to keep the current value; set omitDefinition to true to clear a definition. Source terms, statuses, and occurrence evidence are read-only: correcting damaged PDF extraction requires source recovery and a rescan, not renaming a JSON word key. Import into the same document after the scan finishes. Version 1 imports remain supported.${compactNotice}`,
    words: words.map((row) => ({
      word: row.word,
      count: typeof row.count === 'number' ? row.count : null,
      contexts: Array.isArray(row.contexts) ? row.contexts.filter((value): value is string => typeof value === 'string') : [],
      occurrences: Array.isArray(row.occurrences) ? row.occurrences
        .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value))
        .slice(0, 2).map((occurrence) => {
          if (options?.compactForAi) {
            return {
              surfaceTerm: occurrence.surfaceTerm,
              normalizedTerm: occurrence.normalizedTerm,
              pdfPage: occurrence.pdfPage,
              context: occurrence.context,
              qualityFlags: occurrence.qualityFlags,
              sourceStatus: occurrence.sourceStatus,
            };
          }
          return {
            surfaceTerm: occurrence.surfaceTerm,
            normalizedTerm: occurrence.normalizedTerm,
            pdfPage: occurrence.pdfPage,
            sourceStart: occurrence.sourceStart,
            sourceEnd: occurrence.sourceEnd,
            pageSourceStart: occurrence.pageSourceStart,
            pageSourceEnd: occurrence.pageSourceEnd,
            blockId: occurrence.blockId,
            bbox: occurrence.bbox,
            coordinateSource: occurrence.coordinateSource,
            context: occurrence.context,
            contextTargetStart: occurrence.contextTargetStart,
            contextTargetEnd: occurrence.contextTargetEnd,
            extractionMethod: occurrence.extractionMethod,
            qualityFlags: occurrence.qualityFlags,
            qualityEvidence: occurrence.qualityEvidence,
            sourceStatus: occurrence.sourceStatus,
          };
        }) : [],
      editorialSpellings: Array.isArray(row.editorialSpellings) ? row.editorialSpellings.filter((value): value is string => typeof value === 'string') : [],
      ocrEvidence: Array.isArray(row.ocrEvidence) ? row.ocrEvidence.filter((value): value is string => typeof value === 'string') : [],
      sourceStatus: typeof row.sourceStatus === 'string' ? row.sourceStatus : 'unverified',
      sourceOutcome: typeof row.sourceOutcome === 'string' ? row.sourceOutcome : null,
      qualityFlags: Array.isArray(row.qualityFlags) ? row.qualityFlags.filter((value): value is string => typeof value === 'string') : [],
      pronunciationSource: typeof row.pronunciationSource === 'string' ? row.pronunciationSource : null,
      currentPronunciation: [row.userOverride, row.libraryPronunciation, row.geminiRecommendedPronunciation,
        ...(Array.isArray(row.pronunciations) ? row.pronunciations.map((choice) =>
          typeof choice === 'string' ? choice : choice && typeof choice === 'object' ? (choice as { phonetic?: unknown }).phonetic : null) : [])]
        .find((value): value is string => typeof value === 'string' && value !== '[OMIT]' && isKokoroSafePronunciation(row.word, value)) || null,
      currentDefinition: typeof row.definition === 'string' ? row.definition : null,
      proposedPronunciation: null,
      proposedDefinition: null,
      omitDefinition: Boolean(
        options?.sanitizeStopWords
        && (shouldOmitDictionaryDefinition(row.definition)
          || (typeof row.importWarning === 'string' && row.importWarning.includes('Invalid contextual definition'))),
      ),
      importWarning: typeof row.importWarning === 'string' ? row.importWarning : null,
    })),
  };
}

export function exportForeignWordScanBatches(
  documentId: string,
  words: readonly ScanWord[],
  options?: {
    batchSize?: number;
    compactForAi?: boolean;
  },
): ForeignWordScanBatch[] {
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 100, 5000));
  if (words.length === 0) {
    return [{
      filename: `foreign-words-${documentId}-part-01.json`,
      partIndex: 1,
      totalParts: 1,
      wordCount: 0,
      payload: exportForeignWordScan(documentId, [], { ...options, partIndex: 1, totalParts: 1 }),
    }];
  }

  const totalParts = Math.ceil(words.length / batchSize);
  const padLen = Math.max(2, String(totalParts).length);
  const batches: ForeignWordScanBatch[] = [];

  for (let i = 0; i < totalParts; i++) {
    const chunk = words.slice(i * batchSize, (i + 1) * batchSize);
    const partIndex = i + 1;
    const partStr = String(partIndex).padStart(padLen, '0');
    const filename = `foreign-words-${documentId}-part-${partStr}.json`;
    const payload = exportForeignWordScan(documentId, chunk, {
      compactForAi: options?.compactForAi,
      partIndex,
      totalParts,
    });
    batches.push({
      filename,
      partIndex,
      totalParts,
      wordCount: chunk.length,
      payload,
    });
  }

  return batches;
}

export interface ForeignWordImportSkipped {
  word: string;
  reason: string;
}

export interface ParseForeignWordScanImportOptions {
  allowPartial?: boolean;
}

export interface ForeignWordScanImportResult {
  changes: ForeignWordImportChange[];
  skipped: ForeignWordImportSkipped[];
}

export function parseForeignWordScanImportDetailed(
  value: unknown,
  documentId: string,
  allowedWords: ReadonlySet<string>,
  trustedSourceStatuses: ReadonlyMap<string, string> = new Map(),
  options: ParseForeignWordScanImportOptions = {},
): ForeignWordScanImportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an OpenReader scan JSON object.');
  const input = value as Record<string, unknown>;
  if (input.format !== 'openreader-foreign-word-scan' || (input.version !== 1 && input.version !== 2)) throw new Error('Unsupported scan JSON format or version.');
  if (input.documentId !== documentId) throw new Error('This scan JSON belongs to a different document.');
  if (!Array.isArray(input.words) || input.words.length > 20_000) throw new Error('The scan JSON must contain at most 20,000 words.');
  const seen = new Set<string>();
  const changes: ForeignWordImportChange[] = [];
  const skipped: ForeignWordImportSkipped[] = [];
  let foundAnyProposedEdits = false;

  for (const raw of input.words) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each imported word must be an object.');
    const row = raw as Record<string, unknown>;
    const word = typeof row.word === 'string' ? row.word.normalize('NFC').trim() : '';
    if (!word || !allowedWords.has(word) || seen.has(word)) throw new Error(`Unknown or duplicate scan word: ${word || '(blank)'}.`);
    seen.add(word);

    const hasProposedPronunciation = row.proposedPronunciation !== null && row.proposedPronunciation !== undefined;
    const hasProposedDefinition = row.omitDefinition === true || (row.proposedDefinition !== null && row.proposedDefinition !== undefined);
    if (!hasProposedPronunciation && !hasProposedDefinition) continue;
    foundAnyProposedEdits = true;

    if (trustedSourceStatuses.get(word) === 'needs_source_repair') {
      const reason = `${word} needs PDF source repair and a rescan before pronunciation or definition import.`;
      if (options.allowPartial) {
        skipped.push({ word, reason });
        continue;
      }
      throw new Error(reason);
    }

    const change: ForeignWordImportChange = { word };
    let wordError: string | null = null;

    if (hasProposedPronunciation) {
      if (typeof row.proposedPronunciation !== 'string' || !isKokoroSafePronunciation(word, row.proposedPronunciation)) {
        wordError = `Invalid Kokoro pronunciation for ${word}.`;
      } else {
        change.pronunciation = row.proposedPronunciation;
      }
    }

    if (!wordError && row.omitDefinition === true) {
      if (row.proposedDefinition !== null && row.proposedDefinition !== undefined) {
        wordError = `Conflicting definition edits for ${word}.`;
      } else {
        change.definition = null;
      }
    } else if (!wordError && row.proposedDefinition !== null && row.proposedDefinition !== undefined) {
      if (typeof row.proposedDefinition !== 'string' || shouldOmitDictionaryDefinition(row.proposedDefinition)) {
        wordError = `Invalid contextual definition for ${word}.`;
      } else {
        const definition = normalizeDictionaryDefinition(row.proposedDefinition);
        if (!definition) {
          wordError = `Invalid contextual definition for ${word}.`;
        } else {
          change.definition = definition;
        }
      }
    }

    if (wordError) {
      if (options.allowPartial) {
        skipped.push({ word, reason: wordError });
        continue;
      }
      throw new Error(wordError);
    }

    if (change.pronunciation !== undefined || change.definition !== undefined) {
      changes.push(change);
    }
  }

  if (!foundAnyProposedEdits) throw new Error('No proposed edits were found in the scan JSON.');
  if (!options.allowPartial && !changes.length) throw new Error('No proposed edits were found in the scan JSON.');

  return { changes, skipped };
}

export function parseForeignWordScanImport(
  value: unknown,
  documentId: string,
  allowedWords: ReadonlySet<string>,
  trustedSourceStatuses: ReadonlyMap<string, string> = new Map(),
  options: ParseForeignWordScanImportOptions = {},
): ForeignWordImportChange[] {
  return parseForeignWordScanImportDetailed(value, documentId, allowedWords, trustedSourceStatuses, options).changes;
}
