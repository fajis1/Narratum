import { getForeignWordSourceRepairReasons } from './foreign-word-source-integrity';
import { selectGeminiManualReviewWords } from './foreign-word-scan-results';
import {
  isKokoroSafePronunciation,
  buildKokoroPronunciationInstructions,
  normalizeKokoroPronunciationCandidate,
} from './kokoro-pronunciation-policy';
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
    occurrencesIncluded: number;
    occurrenceDetailsTruncated: boolean;
    editorialSpellings: string[];
    ocrEvidence: string[];
    sourceRepairReasons?: string[];
    rawExtractedSpellings: string[];
    effectiveVerifiedWord: string | null;
    rawOccurrenceCount: number | null;
    approvedAppliedOccurrenceCount: number;
    unmatchedApprovedOccurrenceCount: number;
    unresolvedOccurrenceCount: number | null;
    sourceRecoveryStatus: string | null;
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
              rawSurfaceTerm: occurrence.rawSurfaceTerm,
              sourceRecoveryStatus: occurrence.sourceRecoveryStatus,
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
            rawSurfaceTerm: occurrence.rawSurfaceTerm,
            sourceRecoveryStatus: occurrence.sourceRecoveryStatus,
          };
        }) : [],
      occurrencesIncluded: Math.min(2, Array.isArray(row.occurrences) ? row.occurrences.length : 0),
      occurrenceDetailsTruncated: Array.isArray(row.occurrences) && row.occurrences.length > 2,
      editorialSpellings: Array.isArray(row.editorialSpellings) ? row.editorialSpellings.filter((value): value is string => typeof value === 'string') : [],
      ocrEvidence: Array.isArray(row.ocrEvidence) ? row.ocrEvidence.filter((value): value is string => typeof value === 'string') : [],
      sourceRepairReasons: Array.isArray(row.sourceRepairReasons) ? row.sourceRepairReasons.filter((value): value is string => typeof value === 'string') : [],
      sourceStatus: typeof row.sourceStatus === 'string' ? row.sourceStatus : 'unverified',
      rawExtractedSpellings: Array.isArray(row.sourceRecoveryRawSpellings)
        ? row.sourceRecoveryRawSpellings.filter((value): value is string => typeof value === 'string') : [row.word],
      effectiveVerifiedWord: row.sourceStatus === 'verified_document_reading' ? row.word : null,
      rawOccurrenceCount: typeof row.sourceRecoveryRawOccurrenceCount === 'number' ? row.sourceRecoveryRawOccurrenceCount : typeof row.count === 'number' ? row.count : null,
      approvedAppliedOccurrenceCount: typeof (row.sourceRecoveryCounts as Record<string, unknown> | undefined)?.applied === 'number'
        ? (row.sourceRecoveryCounts as { applied: number }).applied : 0,
      unmatchedApprovedOccurrenceCount: typeof (row.sourceRecoveryCounts as Record<string, unknown> | undefined)?.unmatched === 'number'
        ? (row.sourceRecoveryCounts as { unmatched: number }).unmatched : 0,
      unresolvedOccurrenceCount: typeof row.sourceRecoveryCounts === 'object' && row.sourceRecoveryCounts !== null
        ? Number((row.sourceRecoveryCounts as { unresolved?: unknown }).unresolved || 0) + Number((row.sourceRecoveryCounts as { unmatched?: unknown }).unmatched || 0)
        : typeof row.count === 'number' ? row.count : null,
      sourceRecoveryStatus: typeof row.sourceRecoveryStatus === 'string' ? row.sourceRecoveryStatus
        : row.sourceStatus === 'verified_document_reading' ? 'applied' : null,
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

    if (trustedSourceStatuses.get(word) === 'needs_source_repair' || getForeignWordSourceRepairReasons(word).length > 0) {
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
      const normalizedPronunciation = normalizeKokoroPronunciationCandidate(word, row.proposedPronunciation);
      if (!normalizedPronunciation) {
        wordError = `Invalid Kokoro pronunciation for ${word}.`;
      } else {
        change.pronunciation = normalizedPronunciation;
      }
    }

    if (!wordError && row.omitDefinition === true) {
      change.definition = null;
    } else if (!wordError && row.proposedDefinition !== null && row.proposedDefinition !== undefined) {
      if (typeof row.proposedDefinition !== 'string') {
        wordError = `Invalid contextual definition for ${word}.`;
      } else if (shouldOmitDictionaryDefinition(row.proposedDefinition)) {
        // Deterministic recovery: auto-omit stop-words and function-word-only glosses (e.g. "he", "in them", "from")
        change.definition = null;
      } else {
        const definition = normalizeDictionaryDefinition(row.proposedDefinition);
        change.definition = definition;
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

export interface GenerateForeignWordAiInstructionsOptions {
  documentId?: string;
  totalWords?: number;
  isFlaggedExport?: boolean;
  exportMode?: 'gemini_manual_review';
}

export function generateForeignWordAiInstructions(options?: GenerateForeignWordAiInstructionsOptions): string {
  const isFlagged = options?.isFlaggedExport === true;
  const wordCountStr = typeof options?.totalWords === 'number' ? ` (${options.totalWords} words)` : '';
  const docStr = options?.documentId ? ` for document ID \`${options.documentId}\`` : '';

  return `# OpenReader AI Agent Guide: Processing Foreign Word Scans

## Mission
You are processing an OpenReader foreign-word scan JSON file${docStr}${wordCountStr}.
${options?.exportMode === 'gemini_manual_review' ? GEMINI_MANUAL_REVIEW_INSTRUCTIONS + '\n' : ''}Your goal is to inspect the words and provide:
1. Valid Kokoro IPA pronunciations (\`proposedPronunciation\`)
2. Contextual English definitions (\`proposedDefinition\`)
3. Definition omission flags (\`omitDefinition: true\`) for grammatical stop-words

---

## ⚠️ Core Editing Rules

1. **Which fields to edit**:
   - \`proposedPronunciation\`: Standard Kokoro IPA string wrapped in slashes \`"/.../"\` (e.g. \`"/hɑːdɑːm/"\`, \`"/bəheɪmɑː/"\`). Set to \`null\` if untouched.
   - \`proposedDefinition\`: Concise contextual definition of 1 to 4 words. Set to \`null\` if untouched or omitted.
   - \`omitDefinition\`: Set to \`true\` to omit definitions for stop-words (see Stop-Words rule below).
2. **DO NOT MODIFY**:
   - The \`word\` property is the immutable database key. Never rename or alter the \`word\` string.
   - \`count\`, \`contexts\`, \`occurrences\`, \`sourceStatus\`, \`sourceRepairReasons\`, and \`qualityFlags\` are read-only evidence. Do not alter them.
3. **Format**:
   - The output must be valid JSON matching the exact structure of the input scan file.

---

## 🔊 Kokoro Pronunciation Guidelines

${buildKokoroPronunciationInstructions()}

The validator checks compatibility and word-dependent quality rather than an exhaustive phoneme whitelist. Predictable formatting normalization may remove stress marks or repair delimiters; it never reconstructs or renames damaged source keys.

---

## 📖 Definition Guidelines

OpenReader reads definitions aloud in "Biblical Scholar" audiobook mode.

### Requirements:
1. **Concise Contextual Meaning**: 1 to 4 words maximum (e.g., \`"the human"\`, \`"covenant"\`, \`"grace"\`).
2. **Single Meaning Only**: Do NOT provide run-on glosses with commas or conjunctions (e.g., avoid \`"peace, wholeness, prosperity"\`; choose the single best contextual meaning like \`"peace"\`).
3. **NO Grammatical Stop-Words (Crucial)**:
   - Grammatical pronouns, prepositions, articles, and conjunctions must NOT have definitions spoken in the audiobook.
   - For terms like Hebrew pronouns (\`הוּא\`, \`זֹאת\`, \`לוֹ\`, \`בָּהֶם\`, \`לָהֶם\`), prepositions (\`מִן\`, \`ב\`, \`ל\`, \`כ\`, \`על\`, \`אל\`), or conjunctions (\`ו\`, \`כי\`, \`אשר\`):
     - Set **\`omitDefinition: true\`**
     - Set **\`proposedDefinition: null\`**
   - The importer automatically omits function-word-only glosses such as \`"he"\` or \`"in them"\`. Set the omission fields explicitly rather than supplying a gloss that should not be spoken.
4. **NO Meta-Descriptions**: Do not use placeholders like \`"inflected form"\`, \`"OCR fragment"\`, or \`"unknown"\`. If a word cannot be defined, set \`omitDefinition: true\`.

---

${isFlagged ? `## 🛠️ Handling Flagged Words (\`importWarning\`)

A flagged item may contain an \`importWarning\` describing an import validation problem. Other items may instead be flagged by sourceStatus, sourceOutcome, definition review state, or quality flags. Review the available source evidence. Source-repair terms require PDF source recovery and a rescan; never reconstruct them by renaming the immutable word key. For verified complete terms, repair the indicated pronunciation or definition:
- **\`Invalid contextual definition for <word>\`**: The definition was a stop-word or invalid gloss. Set \`proposedDefinition: null\` and \`omitDefinition: true\`.
- **\`Invalid Kokoro pronunciation for <word>\`**: The pronunciation had invalid characters, numbers, or missing slashes. Provide valid Kokoro phonemes in \`proposedPronunciation: "/.../"\`.
- **\`A valid pronunciation is needed before importing a definition\`**: Provide a valid \`proposedPronunciation: "/.../"\` alongside the definition.
- **\`<word> has a personal profile pronunciation...\`**: Leave \`proposedPronunciation: null\` to keep the user's existing profile override.

---
` : ''}## Example Before and After

### Example 1: Hebrew Pronoun Stop-Word
**Before:**
\`\`\`json
{
  "word": "הוּא",
  "currentPronunciation": "/hu/",
  "proposedPronunciation": null,
  "proposedDefinition": "he",
  "omitDefinition": false
}
\`\`\`

**After (Correct):**
\`\`\`json
{
  "word": "הוּא",
  "currentPronunciation": "/hu/",
  "proposedPronunciation": null,
  "proposedDefinition": null,
  "omitDefinition": true
}
\`\`\`

### Example 2: Foreign Term with Pronunciation Fix
**Before:**
\`\`\`json
{
  "word": "118Lamaštu",
  "currentPronunciation": null,
  "proposedPronunciation": "118lamashtu",
  "proposedDefinition": "Mesopotamian demon",
  "omitDefinition": false
}
\`\`\`

**After (Correct):**
\`\`\`json
{
  "word": "118Lamaštu",
  "currentPronunciation": null,
  "proposedPronunciation": "/lɑːmɑʃtuː/",
  "proposedDefinition": "Mesopotamian demon",
  "omitDefinition": false
}
\`\`\`

### Example 3: Untouched Word (Kept As-Is)
**Before:**
\`\`\`json
{
  "word": "λόγος",
  "currentPronunciation": "/loʊɡɒs/",
  "currentDefinition": "word",
  "proposedPronunciation": null,
  "proposedDefinition": null,
  "omitDefinition": false
}
\`\`\`

**After (No Changes Needed):**
\`\`\`json
{
  "word": "λόγος",
  "currentPronunciation": "/loʊɡɒs/",
  "currentDefinition": "word",
  "proposedPronunciation": null,
  "proposedDefinition": null,
  "omitDefinition": false
}
\`\`\`
`;
}

export const GEMINI_MANUAL_REVIEW_INSTRUCTIONS = 'These terms were eligible for Gemini pronunciation/definition processing but did not receive a resolved usable result. Review source evidence before making changes. Provide a Kokoro-compatible proposedPronunciation only for a verified complete term. Correct definitions where appropriate. Do not modify the immutable word property. Source-repair terms require source recovery and a rescan, never reconstruction by renaming the JSON key.';

export function exportGeminiManualReviewScan(documentId: string, words: readonly ScanWord[], terms: readonly string[]) {
  const payload = exportForeignWordScan(documentId, selectGeminiManualReviewWords(words, terms));
  payload.instructions = `Gemini manual review export (${terms.length} words). ${GEMINI_MANUAL_REVIEW_INSTRUCTIONS}`;
  return payload;
}
