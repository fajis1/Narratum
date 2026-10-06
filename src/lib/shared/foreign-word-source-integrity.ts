/** Source scripts are independent of Kokoro's pronunciation alphabet. */
export const SUPPORTED_SOURCE_SCRIPTS = {
  Latin: /\p{Script=Latin}/u,
  Greek: /\p{Script=Greek}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Ethiopic: /\p{Script=Ethiopic}/u,
} as const;

export function getSupportedSourceScripts(value: string): string[] {
  return Object.entries(SUPPORTED_SOURCE_SCRIPTS)
    .filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

export function hasUnsupportedSourceLetters(value: string): boolean {
  return [...value].some((character) => /\p{L}/u.test(character)
    && !Object.values(SUPPORTED_SOURCE_SCRIPTS).some((pattern) => pattern.test(character))
    && !(SUPPORTED_SOURCE_SCRIPTS.Latin.test(value) && /^[ʾʿʼʽʻ]$/u.test(character)));
}

export function isForeignSourceWord(value: string): boolean {
  return getSupportedSourceScripts(value).some((script) => script !== 'Latin');
}

/**
 * High-confidence integrity failures only, never pronunciation-quality warnings.
 * Normalization here is for inspection; callers must preserve the original key.
 * Single-letter references and historical medial closed mem are not condemned.
 */
export function getForeignWordSourceRepairReasons(word: unknown): string[] {
  if (typeof word !== 'string') return [];
  const value = word.trim();
  const reasons: string[] = [];
  const scripts = getSupportedSourceScripts(value);
  if (scripts.length > 1 || (scripts.length > 0 && hasUnsupportedSourceLetters(value))) {
    reasons.push('Dictionary word mixes writing systems and looks extraction-damaged.');
  }
  // Inspect letter runs, keeping punctuation/abbreviation boundaries intact.
  // NFKD exposes Hebrew presentation forms without changing the stored token.
  const letters = value.normalize('NFKD').replace(/\p{M}/gu, '');
  if (SUPPORTED_SOURCE_SCRIPTS.Hebrew.test(value) && !/['’׳״"]/u.test(value)) {
    const hebrewRuns = letters.match(/[א-ת]+/gu) ?? [];
    for (const run of hebrewRuns) {
      if (run.length < 2) continue;
      if (/^[ךםןףץ]/u.test(run)) reasons.push('Dictionary word starts with a Hebrew final-form letter and looks reversed or OCR-damaged.');
      if (/[כמנפצ]$/u.test(run)) reasons.push('Dictionary word ends with a nonfinal Hebrew letter form and looks OCR-damaged.');
      if (/[ךןףץ]./u.test(run)) reasons.push('Dictionary word contains an internal Hebrew final-form letter and looks OCR-damaged.');
    }
  }
  if (SUPPORTED_SOURCE_SCRIPTS.Greek.test(value)) {
    const greekLetters = value.normalize('NFD').replace(/\p{M}/gu, '');
    if (/σ$/u.test(greekLetters)) reasons.push('Dictionary word ends with nonfinal Greek sigma and looks OCR-damaged.');
    if (/ς[\p{Script=Greek}]/u.test(greekLetters)) reasons.push('Dictionary word contains final Greek sigma before the end of the word.');
  }
  return [...new Set(reasons)];
}

export function classifyForeignWordSourceIntegrity<T extends { word: string; [key: string]: unknown }>(row: T) {
  const reasons = getForeignWordSourceRepairReasons(row.word);
  if (row.ocrFragment === true) reasons.push('Confirmed OCR fragment requires source repair.');
  if (reasons.length === 0) return row;
  return {
    ...row,
    sourceStatus: 'needs_source_repair',
    sourceOutcome: 'needs_source_repair',
    sourceRepairReasons: reasons,
    qualityFlags: [...new Set([
      ...(Array.isArray(row.qualityFlags) ? row.qualityFlags : []), 'deterministic_source_repair',
    ])],
  };
}

export function requiresForeignWordSourceRepair(row: { word?: string; sourceStatus?: unknown; sourceOutcome?: unknown }): boolean {
  return row.sourceStatus === 'needs_source_repair' || row.sourceOutcome === 'needs_source_repair';
}
