import type { SourceRecoveryAnalysis, SourceRecoverySnapshot } from '@/types/source-recovery';

export function sourceRecoverySnapshot(analysis: SourceRecoveryAnalysis): SourceRecoverySnapshot {
  return { schemaVersion: 1, documentId: analysis.documentId, revision: analysis.revision,
    occurrences: structuredClone(analysis.occurrences.filter((item) => item.status === 'approved' && item.proposal)) };
}

/** Exact characters, whitespace layout tolerance only; no Unicode folding. */
function compact(text: string) {
  let value = '';
  const positions: number[] = [];
  for (let index = 0; index < text.length; index++) {
    if (/\s/u.test(text[index]) && value.endsWith(' ')) continue;
    value += /\s/u.test(text[index]) ? ' ' : text[index];
    positions.push(index);
  }
  return { value, positions };
}

export function applySourceRecovery<T extends { text: string; pageNumber: number }>(
  blocks: readonly T[], snapshot: SourceRecoverySnapshot, documentId: string,
): { blocks: T[]; applied: string[]; unmatched: string[] } {
  if (snapshot.schemaVersion !== 1 || snapshot.documentId !== documentId) {
    throw new Error('Source recovery snapshot belongs to a different PDF.');
  }
  const result = blocks.map((block) => ({ ...block }));
  const applied: string[] = [];
  const unmatched: string[] = [];
  const pages = new Map<number, number[]>();
  result.forEach((block, index) => pages.set(block.pageNumber, [...(pages.get(block.pageNumber) || []), index]));
  for (const [page, indices] of pages) {
    const offsets: { index: number; start: number; end: number }[] = [];
    let pageText = '';
    for (const index of indices) {
      if (pageText) pageText += '\n';
      const start = pageText.length;
      pageText += result[index].text;
      offsets.push({ index, start, end: pageText.length });
    }
    const normalized = compact(pageText);
    const edits: { block: number; start: number; end: number; replacement: string; id: string }[] = [];
    for (const item of snapshot.occurrences.filter((entry) => entry.pdfPage === page)) {
      if (item.status !== 'approved' || !item.proposal) continue;
      const before = compact(item.before).value;
      const surface = compact(item.surface).value;
      const after = compact(item.after).value;
      // An isolated spelling cannot identify a particular occurrence safely.
      if (!(before.trim() || after.trim())) { unmatched.push(item.id); continue; }
      const needle = before + surface + after;
      const matches: number[] = [];
      let search = 0;
      while (search <= normalized.value.length) {
        const found = normalized.value.indexOf(needle, search);
        if (found < 0) break;
        const target = found + before.length;
        const left = normalized.value[target - 1] || '';
        const right = normalized.value[target + surface.length] || '';
        if (!/[\p{L}\p{M}\p{N}]/u.test(left) && !/[\p{L}\p{M}\p{N}]/u.test(right)) matches.push(target);
        search = found + 1;
      }
      if (matches.length === 0) {
        // The layout extractor may already have recovered this exact reading.
        const correctedNeedle = before + item.proposal.correctedSurface + after;
        const first = normalized.value.indexOf(correctedNeedle);
        if (first >= 0 && normalized.value.indexOf(correctedNeedle, first + 1) < 0) {
          applied.push(item.id); continue;
        }
      }
      if (matches.length !== 1) { unmatched.push(item.id); continue; }
      const start = normalized.positions[matches[0]];
      const end = normalized.positions[matches[0] + surface.length - 1] + 1;
      const block = offsets.find((entry) => start >= entry.start && end <= entry.end);
      if (!block) { unmatched.push(item.id); continue; }
      const edit = { block: block.index, start: start - block.start, end: end - block.start,
        replacement: item.proposal.correctedSurface, id: item.id };
      if (edits.some((other) => other.block === edit.block && edit.start < other.end && edit.end > other.start)) {
        throw new Error('Approved source corrections overlap; review the PDF analysis again.');
      }
      edits.push(edit);
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      const text = result[edit.block].text;
      result[edit.block].text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
      applied.push(edit.id);
    }
  }
  return { blocks: result, applied, unmatched };
}

export function sourceRecoveryPronunciations(snapshot: SourceRecoverySnapshot | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of snapshot?.occurrences || []) {
    if (item.status !== 'approved' || !item.proposal?.pronunciation) continue;
    const term = item.proposal.correctedSurface;
    if (result[term] && result[term] !== item.proposal.pronunciation) {
      throw new Error('Approved document pronunciations conflict for the same corrected spelling.');
    }
    result[term] = item.proposal.pronunciation;
  }
  return result;
}

/** Re-detect individual accepted readings without changing extracted evidence. */
export function recoverScanRows<T extends { word: string; count: number; occurrences?: {
  surfaceTerm: string; pdfPage: number; pageSourceStart: number; context: string;
  contextTargetStart: number; contextTargetEnd: number;
}[] }>(rows: T[], snapshot: SourceRecoverySnapshot): T[] {
  const approved = new Map(snapshot.occurrences.filter((item) => item.status === 'approved' && item.proposal)
    .map((item) => [JSON.stringify([item.pdfPage, item.pageSourceStart, item.surface]), item]));
  const grouped = new Map<string, T>();
  for (const row of rows) {
    // Legacy/truncated exports cannot safely describe every occurrence.
    if (!row.occurrences || row.occurrences.length !== row.count) {
      grouped.set(row.word, row); continue;
    }
    for (const occurrence of row.occurrences) {
      const correction = approved.get(JSON.stringify([occurrence.pdfPage, occurrence.pageSourceStart, occurrence.surfaceTerm]));
      const chars = Array.from(occurrence.context);
      const before = chars.slice(0, occurrence.contextTargetStart).join('');
      const after = chars.slice(occurrence.contextTargetEnd).join('');
      const anchored = correction && before.endsWith(correction.before) && after.startsWith(correction.after);
      const word = anchored ? correction.proposal!.correctedSurface : row.word;
      const surface = anchored ? word : occurrence.surfaceTerm;
      const context = before + surface + after;
      const nextOccurrence = { ...occurrence, surfaceTerm: surface, context,
        contextTargetEnd: occurrence.contextTargetStart + Array.from(surface).length,
        ...(anchored ? { sourceStatus: 'verified_document_reading', qualityFlags: [], qualityEvidence: {} } : {}) };
      const existing = grouped.get(word);
      if (existing) {
        existing.count++;
        existing.occurrences!.push(nextOccurrence);
      } else grouped.set(word, { ...row, word, count: 1, occurrences: [nextOccurrence],
        contexts: [context],
        ...(anchored ? { sourceStatus: 'verified_document_reading', sourceOutcome: 'valid_word', sourceRepairReasons: [],
          qualityFlags: [], ocrSuspect: false, ocrFragment: false, ocrEvidence: [], automaticIgnoreReason: null,
          pronunciations: correction.proposal!.pronunciation ? [correction.proposal!.pronunciation] : [],
        } : {}) });
    }
  }
  return [...grouped.values()];
}

/** Prevent cleanup from silently undoing a reviewed surface reading. */
export function assertRecoveredReadings(source: string, output: string, snapshot?: SourceRecoverySnapshot) {
  const visible = (text: string) => text.replace(/\[([^\[\]]+)\]\(\/[^\n]*?\/\)/gu, '$1');
  const sourceWords = visible(source).match(/[\p{L}\p{M}]+(?:['’ʾʿ־-][\p{L}\p{M}]+)*/gu) || [];
  const outputWords = visible(output).match(/[\p{L}\p{M}]+(?:['’ʾʿ־-][\p{L}\p{M}]+)*/gu) || [];
  for (const term of new Set(snapshot?.occurrences.filter((item) => item.status === 'approved').map((item) => item.proposal?.correctedSurface))) {
    if (!term) continue;
    const required = sourceWords.filter((word) => word === term).length;
    if (required > outputWords.filter((word) => word === term).length) {
      throw new Error('Gemini cleanup changed or omitted an accepted PDF source reading. Preserve every reviewed surface spelling.');
    }
  }
}

/** Client settings cannot supply accepted decisions; continuing books keep their saved layer. */
export function sourceRecoveryGenerationSettings(input: {
  settings: Record<string, unknown>; documentId: string; hasExistingChapters: boolean;
  previousSettings?: Record<string, unknown>;
}): Record<string, unknown> {
  const result = { ...input.settings };
  delete result.sourceRecoverySnapshot;
  delete result.sourceRecoveryPronunciationSnapshot;
  if (input.hasExistingChapters) {
    const previous = input.previousSettings?.sourceRecoverySnapshot as SourceRecoverySnapshot | undefined;
    if (previous && (previous.schemaVersion !== 1 || previous.documentId !== input.documentId)) {
      throw new Error('Saved source-recovery decisions do not match this PDF.');
    }
    result.sourceRecoverySnapshot = previous ? structuredClone(previous) : {
      schemaVersion: 1, documentId: input.documentId, revision: 0, occurrences: [],
    };
    result.sourceRecoveryPronunciationSnapshot = structuredClone(input.previousSettings?.sourceRecoveryPronunciationSnapshot || {});
  }
  return result;
}
