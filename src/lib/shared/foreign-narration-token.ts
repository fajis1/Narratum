import { getSupportedSourceScripts, hasUnsupportedSourceLetters } from './foreign-word-source-integrity';

/** Script membership includes punctuation. Lexical scanning requires a letter. */
export function containsForeignLexicalLetter(text: string): boolean {
  return [...text].some(character => /\p{Letter}/u.test(character)
    && /[\p{Script=Greek}\p{Script=Hebrew}]/u.test(character));
}

// Broad English letter names, not lexical Greek pronunciations. These are
// local narration conventions and must never become dictionary entries.
const GREEK_LETTER_NAMES: Readonly<Record<string, string>> = {
  α: '/ælfə/', β: '/beɪtə/', γ: '/ɡæmə/', δ: '/dɛltə/', ε: '/ɛpsɪlɒn/',
  ζ: '/zeɪtə/', η: '/eɪtə/', θ: '/θeɪtə/', ι: '/aɪoʊtə/', κ: '/kæpə/',
  λ: '/læmdə/', μ: '/mju/', ν: '/nju/', ξ: '/ksaɪ/', ο: '/ɒmɪkrɒn/',
  π: '/paɪ/', ρ: '/roʊ/', σ: '/sɪɡmə/', τ: '/taʊ/', υ: '/ʊpsɪlɒn/',
  φ: '/faɪ/', χ: '/kaɪ/', ψ: '/psaɪ/', ω: '/oʊmeɪɡə/',
};

export type ForeignNarrationTokenClassification = {
  kind: 'lexical_word' | 'contextual_letter_reference' | 'punctuation' | 'source_damaged' | 'unknown';
  reason: string;
  pronunciation?: string;
  script?: 'Greek' | 'Hebrew' | 'Latin';
};

const ROLE = '(?:edition|translation|manuscript|text|version|recension|codex|witness|siglum|sigla|letter|symbol)';
const FOLLOWING_ROLE = new RegExp(`^\\s+(?:${ROLE})\\b`, 'iu');
const PRECEDING_ROLE = new RegExp(`\\b${ROLE}\\s+$`, 'iu');
// A bibliographic abbreviation immediately followed by a siglum, or a
// numbered citation. No inference from capitalization or token spelling alone.
const CITATION = /\b(?:Gen|Genesis|Exod|Exodus|Lev|Leviticus|Num|Numbers|Deut|Deuteronomy|Josh|Joshua|Judg|Judges|Sam|Samuel|Kings|Chron|Chronicles|Ps|Psalms|Prov|Proverbs|Isa|Isaiah|Jer|Jeremiah|Ezek|Ezekiel|Dan|Daniel)\.?\s*(?:(?:chapter\s+)?\d+(?:(?:\s*(?::|verse)\s*|\s+)\d+)?\s*)?$/iu;
const CHAPTER_VERSE = /\bchapter\s+\d+\s+verse\s+\d+\s*$/iu;

/** Inspect bounded, immediate context. The caller supplies real chapter offsets. */
export function classifyForeignNarrationToken(word: string, text: string, start: number, end: number): ForeignNarrationTokenClassification {
  if (!/\p{Letter}/u.test(word)) return { kind: 'punctuation', reason: 'No lexical letters.' };
  if (hasUnsupportedSourceLetters(word) || getSupportedSourceScripts(word).length > 1) {
    return { kind: 'source_damaged', reason: 'Unsupported or mixed source writing systems require source review.' };
  }
  const pronunciation = GREEK_LETTER_NAMES[word.toLowerCase()];
  const script = /\p{Script=Greek}/u.test(word) ? 'Greek' : /\p{Script=Hebrew}/u.test(word) ? 'Hebrew' : /\p{Script=Latin}/u.test(word) ? 'Latin' : undefined;
  if ([...word].length === 1 && script) {
    const before = text.slice(Math.max(0, start - 120), start);
    const after = text.slice(end, end + 80);
    const role = FOLLOWING_ROLE.test(after) || PRECEDING_ROLE.test(before);
    const citation = CITATION.test(before) || CHAPTER_VERSE.test(before);
    if (role || citation) return {
      kind: 'contextual_letter_reference',
      reason: role ? 'Adjacent scholarly label or explicit letter/symbol reference.' : 'Letter follows a scholarly citation.',
      pronunciation,
      script,
    };
  }
  return containsForeignLexicalLetter(word)
    ? { kind: 'lexical_word', reason: 'Greek/Hebrew lexical letters without established letter-reference context.' }
    : { kind: 'unknown', reason: 'Outside the Greek/Hebrew narration token model.' };
}
