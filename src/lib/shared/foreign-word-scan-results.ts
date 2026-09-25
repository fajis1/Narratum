export type ForeignWordScanResultRow = {
  word: string;
  count?: number;
  pronunciations?: unknown[];
  userOverride?: string | null;
  ocrFragment?: boolean;
  automaticIgnore?: boolean;
  automaticIgnoreReason?: string;
  fuzzyGroupCount?: number;
  fuzzyGroupVariants?: string[];
  [key: string]: unknown;
};

export type PreparedForeignWordScanResultRow<T extends ForeignWordScanResultRow> = T & {
  ocrFragment: boolean;
  automaticIgnore: boolean;
  fuzzyGroupCount?: number;
  fuzzyGroupVariants?: string[];
};

const GREEK = /\p{Script=Greek}/u;
const HEBREW = /\p{Script=Hebrew}/u;
const GREEK_ELISION = /^[\p{Script=Greek}][\u1FBD\u1FBF'’]$/u;
const TRAILING_SCAN_PUNCTUATION = /[··.,;:!?]$/u;
const GREEK_CONSONANTS = new Set('βγδζθκλμνξπρστφχψ'.split(''));
const MAX_FUZZY_GROUP_VARIANTS = 25;

// These terms are real words, but they are low-value articles, conjunctions,
// particles, and prepositions that do not need a reusable audiobook entry.
const GREEK_HEBREW_FUNCTION_TERMS = new Set([
  'ο', 'η', 'το', 'του', 'της', 'τω', 'την', 'τον', 'οι', 'αι', 'τα', 'των', 'τοις', 'ταις', 'τους', 'τας',
  'και', 'δε', 'τε', 'γαρ', 'αλλα', 'μη', 'ου', 'ουκ', 'ουχ', 'εν', 'εις', 'εκ', 'εξ', 'προς', 'απο', 'δια',
  'μετα', 'κατα', 'περι', 'υπερ', 'υπο', 'επι', 'παρα', 'συν', 'ω', 'ει', 'ως', 'αν', 'οτι', 'ινα',
  'את', 'ו', 'ה', 'ב', 'ל', 'כ', 'מ', 'על', 'אל', 'כי', 'אשר', 'עד', 'עם',
]);

export function normalizeForeignWordForFuzzyMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase()
    .normalize('NFC');
}

export function getAutomaticForeignWordIgnoreReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const word = value.normalize('NFC').trim();
  if (!word) return null;
  const folded = normalizeForeignWordForFuzzyMatch(word);

  if (GREEK_ELISION.test(word)) return 'single-letter Greek elision';
  if (GREEK.test(word) && HEBREW.test(word)) {
    return 'adjacent Hebrew and Greek text without a separator';
  }
  if (GREEK.test(word) && /σ$/u.test(word)) {
    return 'Greek OCR fragment ending in non-final sigma';
  }
  if ((GREEK.test(word) || HEBREW.test(word)) && TRAILING_SCAN_PUNCTUATION.test(word)) {
    return 'foreign-word extraction retained trailing punctuation';
  }

  const greekLetters = [...folded].filter((character) => GREEK.test(character));
  if (
    GREEK.test(word)
    && !HEBREW.test(word)
    && greekLetters.length > 0
    && greekLetters.length <= 2
    && greekLetters.every((character) => GREEK_CONSONANTS.has(character))
  ) {
    return 'stray Greek consonant fragment';
  }
  return null;
}

export function isLowValueForeignFunctionTerm(value: unknown): boolean {
  return typeof value === 'string'
    && GREEK_HEBREW_FUNCTION_TERMS.has(normalizeForeignWordForFuzzyMatch(value.trim()));
}

function editDistanceAtMostTwo(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 2) return false;
  const previous = Array.from({ length: left.length + 1 }, (_, index) => index);
  const current = new Array<number>(left.length + 1).fill(0);
  for (let row = 0; row < right.length; row += 1) {
    current[0] = row + 1;
    let rowMinimum = current[0];
    for (let column = 0; column < left.length; column += 1) {
      const cost = left[column] === right[row] ? 0 : 1;
      current[column + 1] = Math.min(
        current[column] + 1,
        previous[column + 1] + 1,
        previous[column] + cost,
      );
      rowMinimum = Math.min(rowMinimum, current[column + 1]);
    }
    if (rowMinimum > 2) return false;
    for (let column = 0; column <= left.length; column += 1) previous[column] = current[column];
  }
  return previous[left.length] <= 2;
}

function isFuzzyMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length > 3 && right.includes(left)) return true;
  if (right.length > 3 && left.includes(right)) return true;
  if (left.length < 4 || right.length < 4) return false;
  return editDistanceAtMostTwo(left, right);
}

export function prepareForeignWordScanRows<T extends ForeignWordScanResultRow>(
  input: readonly T[],
): PreparedForeignWordScanResultRow<T>[] {
  const rows = input.map((row) => {
    const artifactReason = getAutomaticForeignWordIgnoreReason(row.word);
    const functionTerm = isLowValueForeignFunctionTerm(row.word);
    return {
      ...row,
      ocrFragment: row.ocrFragment === true || Boolean(artifactReason),
      automaticIgnore: row.automaticIgnore === true || functionTerm,
      automaticIgnoreReason: row.automaticIgnoreReason
        || artifactReason
        || (functionTerm ? 'common Greek or Hebrew function term' : undefined),
    } as PreparedForeignWordScanResultRow<T>;
  });

  const reviewableIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.ocrFragment !== true && row.automaticIgnore !== true);
  const normalized = reviewableIndexes.map(({ row }) => normalizeForeignWordForFuzzyMatch(row.word));
  const orderedAnchors = reviewableIndexes
    .map((_, index) => index)
    .sort((left, right) => Number(reviewableIndexes[right].row.count || 0)
      - Number(reviewableIndexes[left].row.count || 0)
      || reviewableIndexes[left].row.word.localeCompare(reviewableIndexes[right].row.word));
  const assigned = new Set<number>();
  const groups: number[][] = [];
  for (const anchor of orderedAnchors) {
    if (assigned.has(anchor)) continue;
    const directMatches = orderedAnchors
      .filter((candidate) => !assigned.has(candidate)
        && isFuzzyMatch(normalized[anchor], normalized[candidate]))
      .slice(0, MAX_FUZZY_GROUP_VARIANTS);
    directMatches.forEach((member) => assigned.add(member));
    groups.push(directMatches);
  }

  for (const members of groups) {
    const groupCount = members.reduce(
      (total, member) => total + Number(reviewableIndexes[member].row.count || 0),
      0,
    );
    const variants = members
      .map((member) => reviewableIndexes[member].row)
      .sort((left, right) => Number(right.count || 0) - Number(left.count || 0)
        || left.word.localeCompare(right.word))
      .map((row) => row.word);
    for (const member of members) {
      const rowIndex = reviewableIndexes[member].index;
      rows[rowIndex] = {
        ...rows[rowIndex],
        fuzzyGroupCount: groupCount,
        fuzzyGroupVariants: variants,
      } as PreparedForeignWordScanResultRow<T>;
    }
  }
  return rows;
}

export function isMissingPronunciation(row: ForeignWordScanResultRow): boolean {
  return (!Array.isArray(row.pronunciations) || row.pronunciations.length === 0)
    && !row.userOverride;
}

export function isFlaggedForReview(row: ForeignWordScanResultRow): boolean {
  if (Boolean(row.importWarning)) return true;
  if (row.definitionNeedsReview === true) return true;
  if (row.sourceStatus === 'needs_source_repair' || row.sourceOutcome === 'needs_source_repair') return true;
  if (row.sourceStatus === 'source_review_recommended' || row.sourceOutcome === 'insufficient_context') return true;
  if (Array.isArray(row.qualityFlags) && row.qualityFlags.includes('import_validation_failed')) return true;
  return false;
}

export function sortForeignWordScanRows<T extends ForeignWordScanResultRow>(
  input: readonly T[],
  options: { pinMissingFirst?: boolean } = {},
): T[] {
  return [...input].sort((left, right) => {
    if (options.pinMissingFirst) {
      const missingPriority = Number(isMissingPronunciation(right)) - Number(isMissingPronunciation(left));
      if (missingPriority !== 0) return missingPriority;
    }
    const fuzzyPriority = Number(right.fuzzyGroupCount || right.count || 0)
      - Number(left.fuzzyGroupCount || left.count || 0);
    if (fuzzyPriority !== 0) return fuzzyPriority;
    const countPriority = Number(right.count || 0) - Number(left.count || 0);
    if (countPriority !== 0) return countPriority;
    return left.word.localeCompare(right.word);
  });
}

export function isAutomaticallyIgnoredForeignWord(row: ForeignWordScanResultRow): boolean {
  return row.ocrFragment === true || row.automaticIgnore === true;
}
