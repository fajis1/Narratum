import type { SmartAudioProfile } from '@/types/client';

export const KOKORO_PRONUNCIATION_POLICY_VERSION = 5;

export const KOKORO_COMPATIBILITY_POLICY = `KOKORO PRONUNCIATION COMPATIBILITY POLICY (REQUIRED, VERSION ${KOKORO_PRONUNCIATION_POLICY_VERSION}):
- Use English-compatible IPA intended for Kokoro.
- NEVER use the primary stress marker "ˈ"; it can cause ghost syllables.
- NEVER use a standalone "/o/"; use an English-compatible vowel such as "/oʊ/" or "/ɒ/" when appropriate.
- NEVER insert syllable-boundary periods between vowels.
- Do not use true pharyngeal fricatives such as "ħ" or "ʕ"; approximate them with English-compatible "/k/" or "/x/" sounds.
- NEVER place /y/ directly beside /j/ or repeat /j/; choose one appropriate glide so Kokoro does not speak separate letter names.
- For initialisms, use single capital letters separated by commas and spaces, such as "K, T, L"; NEVER group capitals as "TH, N".
- Return one reusable dictionary term at a time. Never use an IPA string, a phrase containing spaces, a mixed-script OCR token, or a stray consonant fragment as the dictionary word.
- Never return a stuttered pronunciation with an adjacent repeated token. Spell source letters individually only for a real initialism, never as a fallback for unreadable OCR.
- Pronounce the complete source word, not only a suffix or other surviving OCR fragment. For a word beginning Greek πν or Latin pn, the initial p is silent and must not appear in the pronunciation.
- Preserve Kokoro markup exactly as "[Original Text](/IPA/)" when markup is requested.
- When returning pronunciation choices as JSON, return each pronunciation as a slash-delimited IPA string and no explanatory prose.
These compatibility requirements cannot be removed by profile-specific guidance.`;

export const DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE = `DEFAULT KOKORO PRONUNCIATION GUIDANCE:
Prefer clear, natural English-compatible phonetic approximations that Kokoro can synthesize reliably.
For Koine Greek (Strict Erasmian), use these defaults where applicable: α=/ɑ/, ε=/ɛ/, η=/eɪ/, ι=/i/, ο=/oʊ/ or /ɒ/, υ=/u/, ω=/oʊ/, αι=/aɪ/, ει=/eɪ/, οι=/ɔɪ/, ου=/u/, ευ=/ju/, χ=/k/, θ=/θ/.
For Biblical Hebrew (Standard Academic), use these defaults where applicable: Qamats/Patah=/ɑ/, Tsere/Segol=/ɛ/ or /eɪ/, Hireq=/i/, Holem=/oʊ/, Shureq/Qibbuts=/u/, Shewa=/ə/ when vocal, and Het/Khaf=/k/ or /x/.
For Greek and Hebrew initialisms, abbreviations, and letter-based references, first determine from context whether the text is an abbreviation rather than a lexical word. Do not apply foreign-word IPA to an initialism. Transliterate the source letters into English letter names separated by commas and spaces so Kokoro speaks them individually; for example, Greek κτλ (the initialism of και τα λοιπά / “etc.”) becomes "K, T, L", and κ.τ.λ. follows the same rule. Do not expand the abbreviation unless the surrounding text explicitly provides its expansion. This initialism rule takes precedence over the normal Greek/Hebrew IPA rule.
For English heteronyms and ambiguous homographs (words spelled the same but pronounced differently, such as the proper name "Job" /dʒoʊb/ vs. the occupation "job", or "live" /laɪv/ vs. "live" /lɪv/), analyze the surrounding context carefully. Whenever context dictates a specific pronunciation that the TTS engine might get wrong, always supply the exact phonetic markup but prefix the IPA with an exclamation mark (e.g., [Job](!/dʒoʊb/) or [live](!/laɪv/)). This special syntax prevents heteronyms from polluting the global pronunciation dictionary.
For fantasy names, proper nouns, and other languages, favor a readable English-compatible pronunciation over narrow or unsupported IPA.`;



export interface PronunciationGuidanceProfile {
  pronunciationPromptMode?: 'default' | 'custom';
  customPronunciationPrompt?: string;
}

export function resolvePronunciationGuidance(
  profile?: PronunciationGuidanceProfile | SmartAudioProfile | null,
): string {
  if (profile?.pronunciationPromptMode === 'custom') {
    const custom = profile.customPronunciationPrompt?.trim();
    if (custom) return custom;
  }
  return DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE;
}

export function buildKokoroPronunciationInstructions(
  profile?: PronunciationGuidanceProfile | SmartAudioProfile | null,
): string {
  return `${resolvePronunciationGuidance(profile)}\n\n${KOKORO_COMPATIBILITY_POLICY}`;
}

export function getKokoroPronunciationCompatibilityErrors(pronunciation: unknown): string[] {
  if (typeof pronunciation !== 'string') return ['Pronunciation must be text.'];
  const trimmed = pronunciation.trim();
  if (!/^\/[^/]+\/$/.test(trimmed)) return ['Pronunciation must be a single slash-delimited IPA value.'];

  const inner = trimmed.slice(1, -1);
  const errors: string[] = [];
  if (inner === 'o') errors.push('Standalone /o/ is not supported.');
  if (inner.includes('ˈ')) errors.push('Primary stress marker ˈ is not supported.');
  if (/[ħʕ]/u.test(inner)) errors.push('True pharyngeal fricatives are not supported.');
  if (/[aeiouɑɒɔəɛɪʊ]\.[aeiouɑɒɔəɛɪʊ]/iu.test(inner)) {
    errors.push('Syllable-boundary periods between vowels are not supported.');
  }
  return errors;
}

export function isKokoroCompatiblePronunciation(pronunciation: unknown): pronunciation is string {
  return getKokoroPronunciationCompatibilityErrors(pronunciation).length === 0;
}

function scriptsIn(value: string): number {
  return [
    /\p{Script=Latin}/u.test(value),
    /\p{Script=Greek}/u.test(value),
    /\p{Script=Hebrew}/u.test(value),
  ].filter(Boolean).length;
}

function greekConsonantFragment(value: string): boolean {
  const normalized = value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const letters = [...normalized].filter((character) => /\p{L}/u.test(character));
  return /\p{Script=Greek}/u.test(value)
    && normalized !== 'κτλ'
    && letters.length >= 2
    && !/[αεηιουω]/u.test(normalized);
}

function greekVowelNuclei(value: string): number {
  const letters = [...value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()]
    .filter((character) => /\p{Script=Greek}/u.test(character));
  let count = 0;
  for (let index = 0; index < letters.length; index += 1) {
    if (
      index === 0
      && ['ι', 'υ'].includes(letters[index])
      && 'αεηιουω'.includes(letters[index + 1] || '')
    ) continue;
    if (!'αεηιουω'.includes(letters[index])) continue;
    const pair = `${letters[index]}${letters[index + 1] || ''}`;
    if (['αι', 'ει', 'οι', 'ου', 'αυ', 'ευ', 'ηυ', 'υι', 'ηι', 'ωι'].includes(pair)) index += 1;
    count += 1;
  }
  return count;
}

function ipaVowelNuclei(value: string): number {
  const characters = [...value.trim().replace(/^\/|\/$/g, '').toLowerCase()];
  const isVowel = (character: string) => /[aeiouyɑɒɔəɛɜɞɪʊæʌɨɐøœɯɤɵɚɝ]/u.test(character);
  const diphthongs = new Set(['aɪ', 'aʊ', 'eɪ', 'ɔɪ', 'oʊ', 'əʊ', 'ɛɪ', 'ɑɪ', 'ɑʊ']);
  let count = 0;
  for (let index = 0; index < characters.length; index += 1) {
    if (!isVowel(characters[index])) continue;
    if (diphthongs.has(`${characters[index]}${characters[index + 1] || ''}`)) index += 1;
    if (characters[index + 1] === 'ː') index += 1;
    count += 1;
  }
  return count;
}

export function getKokoroPronunciationWordWarnings(word: unknown): string[] {
  if (typeof word !== 'string') return ['Dictionary word must be text.'];
  const trimmed = word.trim();
  if (!trimmed) return ['Dictionary word cannot be blank.'];

  const warnings: string[] = [];
  if (trimmed.includes('/')) warnings.push('Dictionary word looks like IPA or slash-delimited markup.');
  if (/\s/u.test(trimmed)) warnings.push('Dictionary word must be one reusable term, not a phrase.');
  if (/[\[\]{}()<>\d]/u.test(trimmed)) warnings.push('Dictionary word contains markup or digits.');
  if (/^[-–—]|[-–—]$/u.test(trimmed)) warnings.push('Dictionary word is truncated at a dash.');
  if (/[_\\]/u.test(trimmed)) warnings.push('Dictionary word contains a markup or separator character.');
  if (/[ɐ-ʯː]/u.test(trimmed)) warnings.push('Dictionary word looks like bare IPA rather than source text.');
  if (scriptsIn(trimmed) > 1) warnings.push('Dictionary word mixes Latin, Greek, or Hebrew scripts.');
  if (!/[\p{Script=Latin}\p{Script=Greek}\p{Script=Hebrew}]/u.test(trimmed) || [...trimmed].some((character) => (
    /\p{L}/u.test(character)
    && !/[\p{Script=Latin}\p{Script=Greek}\p{Script=Hebrew}]/u.test(character)
    && !(/\p{Script=Latin}/u.test(trimmed) && /[ʾʿʼʽʻ]/u.test(character))
  ))) warnings.push('Dictionary word contains an unsupported or mixed writing system.');
  if (/\p{Script=Greek}/u.test(trimmed) && /σ$/u.test(trimmed)) {
    warnings.push('Dictionary word ends with nonfinal Greek sigma and looks OCR-damaged.');
  }
  if (/\p{Script=Greek}/u.test(trimmed) && /ς.+/u.test(trimmed)) {
    warnings.push('Dictionary word contains final Greek sigma before the end of the word.');
  }
  if (/\p{Script=Hebrew}/u.test(trimmed) && /^[ךםןףץ]/u.test(trimmed)) {
    warnings.push('Dictionary word starts with a Hebrew final-form letter and looks reversed or OCR-damaged.');
  }
  if (/\p{Script=Hebrew}/u.test(trimmed) && /[כמנפצ]$/u.test(trimmed)) {
    warnings.push('Dictionary word ends with a nonfinal Hebrew letter form and looks OCR-damaged.');
  }
  if (greekConsonantFragment(trimmed)) warnings.push('Dictionary word looks like a stray Greek consonant fragment.');

  const isForeign = /[\p{Script=Greek}\p{Script=Hebrew}]/u.test(trimmed);
  const letters = [...trimmed.normalize('NFD').replace(/\p{M}/gu, '')]
    .filter((character) => /\p{L}/u.test(character))
    .map((character) => character.toLowerCase());
  if (isForeign && letters.length >= 2 && new Set(letters).size === 1) {
    warnings.push('Dictionary word is a repeated-letter OCR fragment.');
  }
  if (/\p{Script=Greek}/u.test(trimmed) && letters.length === 1 && !/[αεηιουω]/u.test(letters[0])) {
    warnings.push('Dictionary word is a single stray Greek consonant.');
  }
  return [...new Set(warnings)];
}

const LETTER_NAME_TOKENS = new Set([
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'eɪ', 'biː', 'siː', 'diː', 'iː', 'ɛf', 'dʒiː', 'eɪtʃ', 'aɪ',
  'dʒeɪ', 'keɪ', 'ɛl', 'ɛm', 'ɛn', 'oʊ', 'piː', 'kjuː', 'ɑːr',
  'ɛs', 'tiː', 'juː', 'viː', 'dʌbəljuː', 'ɛks', 'waɪ', 'ziː',
]);

function pronunciationTokens(pronunciation: string): string[] {
  return pronunciation.trim().replace(/^\/|\/$/g, '')
    .split(/[\s,;_-]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

export function getKokoroPronunciationQualityWarnings(
  word: string,
  pronunciation: unknown,
): string[] {
  const warnings = [
    ...getKokoroPronunciationWordWarnings(word),
    ...getKokoroPronunciationCompatibilityErrors(pronunciation),
  ];
  if (typeof pronunciation !== 'string') return warnings;
  const inner = pronunciation.trim().replace(/^\/|\/$/g, '');
  const normalizedWord = word.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if ((normalizedWord.startsWith('πν') || normalizedWord.startsWith('pn')) && /^p/iu.test(inner)) {
    warnings.push('Pronounces a silent initial p before n.');
  }
  if (
    /\p{Script=Greek}/u.test(word)
    && greekVowelNuclei(word) - ipaVowelNuclei(pronunciation) >= 1
  ) {
    warnings.push('Pronunciation covers only part of the Greek source word.');
  }
  if (/[yj]{2,}/iu.test(inner)) {
    warnings.push('Suspicious adjacent /y/ and /j/ phonemes may be spoken as separate letter names.');
  }
  if (/\b(?:open|close|slash)\b/iu.test(inner)) {
    warnings.push('Contains markup words that may be spoken literally.');
  }
  if (/[\[\]()]|\s{2,}/u.test(inner)) {
    warnings.push('Contains unexpected markup or spacing inside the pronunciation.');
  }
  if (/[A-Z]{2,}/u.test(inner)) {
    warnings.push('Contains grouped capital letters; initialism letters must be separated.');
  }
  const tokens = pronunciationTokens(pronunciation);
  if (tokens.some((token, index) => index > 0 && token === tokens[index - 1])) {
    warnings.push('Contains an adjacent repeated pronunciation token that may sound stuttered.');
  }
  if (
    /[\p{Script=Greek}\p{Script=Hebrew}]/u.test(word)
    && word.normalize('NFC').toLowerCase() !== 'κτλ'
    && tokens.length >= 3
    && tokens.every((token) => LETTER_NAME_TOKENS.has(token))
  ) {
    warnings.push('Spells an apparent OCR fragment as letter names instead of pronouncing a word.');
  }
  if (
    /[\p{Script=Greek}\p{Script=Hebrew}]/u.test(word)
    && word.normalize('NFC').toLowerCase() !== 'κτλ'
    && tokens.length >= 4
    && tokens.every((token) => [...token.replace(/[ːˑ]/gu, '')].length <= 2)
  ) {
    warnings.push('Spells a word as separate phoneme tokens and may sound stuttery.');
  }
  return [...new Set(warnings)];
}

export function isKokoroSafePronunciation(
  word: string,
  pronunciation: unknown,
): pronunciation is string {
  return getKokoroPronunciationQualityWarnings(word, pronunciation).length === 0;
}

export function filterKokoroCompatiblePronunciationRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const result: Record<string, string> = {};
  for (const [word, pronunciation] of Object.entries(value)) {
    const trimmedWord = word.trim();
    if (trimmedWord && isKokoroSafePronunciation(trimmedWord, pronunciation)) {
      result[trimmedWord] = (pronunciation as string).trim();
    }
  }
  return result;
}

/**
 * Normalizes a candidate pronunciation string (e.g. from Gemini or imported JSON),
 * repairing predictable formatting issues such as:
 * - Unwrapping markdown markup: `[word](/ipa/)` or `[/ipa/]` or `[ipa]`
 * - Fixing malformed delimiter endings: `/]` or `/)` -> `/`
 * - Ensuring leading/trailing forward slash delimiters: `ipa` -> `/ipa/`
 * - Stripping unsupported primary/secondary stress markers `[ˈˌ']` (which cause ghost syllables in Kokoro)
 * - Removing vowel syllable boundary periods (e.g. `a.i` -> `ai`)
 * - Compacting inner whitespace between phonemes/syllables for single words (e.g. `/hɑː dɑːm/` -> `/hɑːdɑːm/`)
 * - Stripping leading/trailing digits or stray punctuation from phonemes
 *
 * Returns the normalized, safe slash-wrapped IPA string if valid, or null if unrecoverable.
 */
export function normalizeKokoroPronunciationCandidate(
  word: string,
  raw: unknown,
): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;

  // If the raw input has no slashes, no brackets, and no non-ASCII IPA characters,
  // it is plain text (e.g. "not IPA", "plain text"), not an IPA candidate.
  const hasDelimitersOrIpa = /[/[\]]/.test(text)
    || /[\p{Script=Greek}\p{Script=Hebrew}\p{Mark}ɑɒɔəɛɜɪʊæʌɨɐøœɯɤɵɚɝːˈˌθðʃʒŋʔʾʿ]/u.test(text);
  if (!hasDelimitersOrIpa) {
    return null;
  }

  // 1. Unwrap markdown tag if formatted as [word](/ipa/) or [/ipa/] or [word](!/ipa/)
  const tagMatch = /\[[^\]]*\]\(!?\/([^/\r\n]+)\/?\)?/u.exec(text);
  if (tagMatch) {
    text = `/${tagMatch[1]}/`;
  } else if (text.startsWith('[') && text.endsWith(']')) {
    text = text.slice(1, -1).trim();
  }

  // 2. Strip surrounding quotes if present
  text = text.replace(/^["'`]|["'`]$/gu, '').trim();

  // 3. Fix malformed closing delimiter typos like /] or /)
  text = text.replace(/\/[\)\]]+$/u, '/');

  // 4. Ensure wrapping slashes
  if (!text.startsWith('/')) text = `/${text}`;
  if (!text.endsWith('/')) text = `${text}/`;

  let inner = text.slice(1, -1).trim();
  if (!inner) return null;

  // 5. Strip stress markers (Kokoro bans primary stress ˈ because it causes ghost syllables)
  inner = inner.replace(/[ˈˌ']/gu, '');

  // 6. Strip leading/trailing digits if attached by OCR (e.g. 118 from 118Lamaštu)
  inner = inner.replace(/^\d+|\d+$/gu, '');

  // 7. Remove syllable-boundary periods between vowels (e.g. a.i -> ai)
  inner = inner.replace(/([aeiouɑɒɔəɛɪʊ])\.([aeiouɑɒɔəɛɪʊ])/giu, '$1$2');

  // 8. Strip trailing non-phoneme punctuation (e.g. stray commas, semicolons)
  inner = inner.replace(/[,;]+$/gu, '').trim();

  // Disallow non-phoneme symbols (e.g. !@#$%^&*+=<>~?)
  if (/[^\p{L}\p{M}ː, \t'-]/u.test(inner)) {
    return null;
  }

  // 9. For initialisms (e.g. /K, T, L/), normalize comma spacing.
  // For single words (no whitespace in dictionary word), compact any whitespace
  // between phonemes or syllables, e.g. "/hɑː dɑːm/" -> "/hɑːdɑːm/"
  // (matches smart-audio-cleanup buildPronunciationLookup and scanPronunciationIssues)
  const trimmedWord = typeof word === 'string' ? word.trim() : '';
  const isInitialism = /^[A-Z](?:,\s*[A-Z])*$/u.test(inner);
  if (isInitialism) {
    inner = inner.replace(/,\s*/gu, ', ');
  } else if (!trimmedWord || !/\s/u.test(trimmedWord)) {
    inner = inner.replace(/\s+/gu, '');
  }

  if (!inner) return null;


  const candidate = `/${inner}/`;


  const strippedWord = trimmedWord.replace(/^\d+|\d+$/gu, '');
  if (trimmedWord && isKokoroSafePronunciation(trimmedWord, candidate)) {
    return candidate;
  }
  if (strippedWord && isKokoroSafePronunciation(strippedWord, candidate)) {
    return candidate;
  }
  if (!trimmedWord && isKokoroCompatiblePronunciation(candidate)) {
    return candidate;
  }

  return null;
}
