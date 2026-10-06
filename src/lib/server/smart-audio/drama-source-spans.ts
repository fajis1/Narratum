/** Immutable, lossless source units. IDs are assigned once per authoritative chapter. */
export interface DramaSourceSpan { readonly id: string; readonly text: string }

export const DRAMA_DIRECTOR_MAX_SOURCE_BYTES = 12_000;
// Worst case: each span needs its own metadata object (~300 tokens). This bounds
// dialogue-heavy output independently of prose bytes, leaving output headroom.
export const DRAMA_DIRECTOR_MAX_SPANS = 48;
const SPAN_TARGET_BYTES = 600;

export function createDramaSourceSpans(sourceText: string): DramaSourceSpan[] {
  const pieces: string[] = [];
  let pending = '';
  let bytes = 0;
  const flush = () => {
    if (pending) pieces.push(pending);
    pending = '';
    bytes = 0;
  };
  // Pronunciation markup is atomic. Quotes are separate tokens; apostrophes
  // inside words are not dialogue boundaries. No normalization or trim occurs.
  const tokens = sourceText.match(/\[[^\]]+\]\(\/[^)]*\/\)|[“”"]|\s+|[^\s“”"\[]+|\[/gu) || [];
  let quoted = false;
  for (const token of tokens) {
    const size = Buffer.byteLength(token, 'utf8');
    if (token === '“' || token === '”' || token === '"') {
      const opening: boolean = token === '“' || token === '"' && !quoted;
      if (opening) flush();
      pending += token;
      bytes += size;
      quoted = opening;
      if (!opening) flush();
      continue;
    }
    if (pending && bytes + size > SPAN_TARGET_BYTES) flush();
    pending += token;
    bytes += size;
    if (/\n/u.test(token) || /[.!?…]$/u.test(token) || bytes >= SPAN_TARGET_BYTES) flush();
  }
  flush();
  const spans = pieces.map((text, index) => Object.freeze({ id: `s${String(index + 1).padStart(6, '0')}`, text }));
  assertDramaSourceSpans(sourceText, spans);
  return spans;
}

export function assertDramaSourceSpans(sourceText: string, spans: readonly DramaSourceSpan[]): void {
  if (!spans.length || spans.some((span) => !span.id || !span.text)
    || new Set(spans.map((span) => span.id)).size !== spans.length
    || spans.map((span) => span.text).join('') !== sourceText) {
    throw new Error('Invalid immutable Drama source spans.');
  }
}

/** Budget both source bytes and worst-case directed segment count; never cut a span. */
export function batchDramaSourceSpans(spans: readonly DramaSourceSpan[], options?: { maxBytes?: number; maxSpans?: number }): DramaSourceSpan[][] {
  const maxBytes = options?.maxBytes ?? DRAMA_DIRECTOR_MAX_SOURCE_BYTES;
  const maxSpans = options?.maxSpans ?? DRAMA_DIRECTOR_MAX_SPANS;
  if (!Number.isInteger(maxBytes) || maxBytes < 4 || !Number.isInteger(maxSpans) || maxSpans < 1) throw new Error('Invalid Director batch budget.');
  const batches: DramaSourceSpan[][] = [];
  let start = 0;
  while (start < spans.length) {
    let end = start;
    let bytes = 0;
    while (end < spans.length && end - start < maxSpans) {
      const size = Buffer.byteLength(spans[end].text, 'utf8');
      if (size > maxBytes) throw new Error(`Immutable source span ${spans[end].id} exceeds Director byte budget.`);
      if (bytes + size > maxBytes) break;
      bytes += size;
      end += 1;
    }
    if (end < spans.length) {
      // Prefer a paragraph, then sentence boundary in the latter half. Keep
      // reasonable fill so a chapter does not degenerate into tiny calls.
      const minimum = start + Math.max(1, Math.floor((end - start) / 2));
      for (const boundary of [/\n\s*$/u, /[.!?…][”"]?\s*$/u]) {
        let preferred = end;
        while (preferred >= minimum && !boundary.test(spans[preferred - 1].text)) preferred -= 1;
        if (preferred >= minimum) { end = preferred; break; }
      }
    }
    batches.push(spans.slice(start, end));
    start = end;
  }
  return batches;
}
