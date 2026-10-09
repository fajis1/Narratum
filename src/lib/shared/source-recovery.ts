import { requiresForeignWordSourceRepair } from './foreign-word-source-integrity';
import type { SourceRecoveryAnalysis, SourceRecoverySnapshot } from '@/types/source-recovery';

export function sourceRecoverySnapshot(analysis: SourceRecoveryAnalysis): SourceRecoverySnapshot {
  return { schemaVersion: 1, documentId: analysis.documentId, revision: analysis.revision,
    occurrences: structuredClone(analysis.occurrences.filter((item) => item.status === 'approved' && !item.anchorInvalidated && item.proposal)) };
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
      if (item.status !== 'approved' || item.anchorInvalidated || !item.proposal) continue;
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
      // Identical contexts are common in repeated quotations. A page-local
      // ordinal is safe only when the indexed source count agrees exactly with
      // the independently extracted page text and the surrounding context at
      // that ordinal still matches.
      let ordinalTarget: { target: number; alreadyCorrected: boolean } | null = null;
      const ordinal = item.surfaceOccurrenceIndex;
      const expectedCount = item.surfaceOccurrenceCount;
      if (Number.isInteger(ordinal) && Number.isInteger(expectedCount) && expectedCount! > 1) {
        const sameSource = snapshot.occurrences.filter((entry) => entry.pdfPage === page
          && entry.surface === item.surface && entry.surfaceOccurrenceCount === expectedCount);
        const acceptableSurfaces = new Set([item.surface, ...sameSource
          .map((entry) => entry.proposal?.correctedSurface).filter((surface): surface is string => !!surface)]);
        const candidates: { target: number; surface: string; alreadyCorrected: boolean }[] = [];
        for (const candidateSurface of acceptableSurfaces) {
          const token = compact(candidateSurface).value;
          let cursor = 0;
          while (cursor <= normalized.value.length) {
            const found = normalized.value.indexOf(token, cursor);
            if (found < 0) break;
            const left = normalized.value[found - 1] || '';
            const right = normalized.value[found + token.length] || '';
            if (!/[\p{L}\p{M}\p{N}]/u.test(left) && !/[\p{L}\p{M}\p{N}]/u.test(right)) {
              candidates.push({ target: found, surface: candidateSurface, alreadyCorrected: candidateSurface !== item.surface });
            }
            cursor = found + token.length;
          }
        }
        candidates.sort((a, b) => a.target - b.target);
        if (candidates.length === expectedCount) {
          const selected = candidates[ordinal!];
          if (selected.alreadyCorrected && selected.surface !== item.proposal.correctedSurface) {
            unmatched.push(item.id); continue;
          }
          const selectedSurface = compact(selected.surface).value;
          const leftContext = normalized.value.slice(Math.max(0, selected.target - before.length), selected.target);
          const rightContext = normalized.value.slice(selected.target + selectedSurface.length,
            selected.target + selectedSurface.length + after.length);
          if (leftContext.endsWith(before) && rightContext.startsWith(after)) {
            ordinalTarget = { target: selected.target, alreadyCorrected: selected.alreadyCorrected };
          }
        }
      }
      if (ordinalTarget?.alreadyCorrected) { applied.push(item.id); continue; }
      if (ordinalTarget) matches.splice(0, matches.length, ordinalTarget.target);
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
    if (item.status !== 'approved' || item.anchorInvalidated || !item.proposal?.pronunciation) continue;
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
  rawSurfaceTerm?: string; sourceRecoveryStatus?: string; sourceRecoveryPronunciation?: string;
}[] }>(rows: T[], snapshot: SourceRecoverySnapshot): Array<T & {
  sourceRecoveryCounts: { applied: number; unmatched: number; unresolved: number };
}> {
  const approved = new Map(snapshot.occurrences.filter((item) => item.status === 'approved' && !item.anchorInvalidated && item.proposal)
    .map((item) => [JSON.stringify([item.pdfPage, item.pageSourceStart, item.surface]), item]));
  const grouped = new Map<string, Record<string, unknown>>();
  const add = (row: T, word: string, occurrence?: NonNullable<T['occurrences']>[number], status: 'applied' | 'unmatched' | 'unresolved' = 'unresolved') => {
    let output = grouped.get(word);
    if (!output) {
      output = { ...row, word, count: 0, occurrences: [], contexts: [], sourceRecoveryRawOccurrenceCount: 0,
        sourceRecoveryRawSpellings: [], sourceRecoveryCounts: { applied: 0, unmatched: 0, unresolved: 0 } };
      grouped.set(word, output);
    }
    output.count = Number(output.count) + 1;
    output.sourceRecoveryRawOccurrenceCount = Number(output.sourceRecoveryRawOccurrenceCount) + 1;
    const rawSpellings = output.sourceRecoveryRawSpellings as string[];
    if (!rawSpellings.includes(row.word)) rawSpellings.push(row.word);
    const counts = output.sourceRecoveryCounts as { applied: number; unmatched: number; unresolved: number };
    counts[status]++;
    if (status !== 'applied' && requiresForeignWordSourceRepair(row)) output.sourceRecoveryRequiresRepair = true;
    if (occurrence) {
      const occurrences = output.occurrences as Record<string, unknown>[];
      occurrences.push(occurrence as unknown as Record<string, unknown>);
      const contexts = output.contexts as string[];
      if (contexts.length < 2 && !contexts.includes(occurrence.context)) contexts.push(occurrence.context);
    }
    if (status === 'applied') {
      output.sourceStatus = 'verified_document_reading';
      output.sourceOutcome = 'valid_word';
      output.sourceRepairReasons = [];
      output.qualityFlags = [];
      output.ocrSuspect = false;
      output.ocrFragment = false;
      output.latinizedOcrCandidate = false;
      output.ocrEvidence = [];
      output.automaticIgnoreReason = null;
      const occurrenceRecord = occurrence as unknown as { sourceRecoveryPronunciation?: string } | undefined;
      if (occurrenceRecord?.sourceRecoveryPronunciation) {
        const pronunciations = Array.isArray(output.pronunciations) ? output.pronunciations as string[] : [];
        if (!pronunciations.includes(occurrenceRecord.sourceRecoveryPronunciation)) pronunciations.push(occurrenceRecord.sourceRecoveryPronunciation);
        output.pronunciations = pronunciations;
      }
    }
  };
  for (const row of rows) {
    const occurrences = row.occurrences || [];
    for (const occurrence of occurrences) {
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
        ...(anchored ? { rawSurfaceTerm: occurrence.surfaceTerm, sourceRecoveryStatus: 'applied', sourceStatus: 'verified_document_reading', qualityFlags: [], qualityEvidence: {},
          sourceRecoveryPronunciation: correction.proposal!.pronunciation || undefined }
          : { sourceRecoveryStatus: correction ? 'anchor_mismatch' : 'unresolved' }) };
      add(row, word, nextOccurrence, anchored ? 'applied' : correction ? 'unmatched' : 'unresolved');
    }
    // Do not discard exact approved anchors just because an older/imported scan
    // contains only sample occurrences. Unrepresented count stays unresolved.
    for (let remaining = Math.max(0, row.count - occurrences.length); remaining > 0; remaining--) add(row, row.word);
  }
  for (const output of grouped.values()) {
    if (output.sourceRecoveryRequiresRepair) {
      output.sourceStatus = 'needs_source_repair';
      output.sourceOutcome = 'needs_source_repair';
    }
    const counts = output.sourceRecoveryCounts as { applied: number; unmatched: number; unresolved: number };
    if (counts.applied > 0 && (counts.unmatched > 0 || counts.unresolved > 0)) {
      if (!output.sourceRecoveryRequiresRepair) output.sourceStatus = 'source_review_recommended';
      output.sourceRecoveryStatus = 'mixed_occurrences';
    }
  }
  return [...grouped.values()] as Array<T & {
    sourceRecoveryCounts: { applied: number; unmatched: number; unresolved: number };
  }>;
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
