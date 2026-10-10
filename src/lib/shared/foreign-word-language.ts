/** Language is inferred from context; a writing system alone is not a language. */
export const FOREIGN_WORD_LANGUAGES = {
  koine_greek: 'Koine Greek', modern_greek: 'Modern Greek', biblical_hebrew: 'Biblical Hebrew',
  modern_hebrew: 'Modern Hebrew', aramaic: 'Aramaic', latin: 'Latin', german: 'German',
  french: 'French', russian: 'Russian', church_slavonic: 'Church Slavonic',
  arabic: 'Arabic', chinese: 'Chinese', japanese: 'Japanese', geez: 'Geʽez',
  english: 'English', other: 'Other language', unknown: 'Language uncertain',
} as const;

export type ForeignWordLanguage = keyof typeof FOREIGN_WORD_LANGUAGES;
export type ForeignWordLanguageMetadata = {
  detectedLanguage?: ForeignWordLanguage;
  languageConfidence?: number;
  ambiguityReason?: 'language' | 'abbreviation';
};

export function readForeignWordLanguageMetadata(input: unknown): ForeignWordLanguageMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  return {
    ...(typeof value.detectedLanguage === 'string' && Object.hasOwn(FOREIGN_WORD_LANGUAGES, value.detectedLanguage)
      ? { detectedLanguage: value.detectedLanguage as ForeignWordLanguage } : {}),
    ...(typeof value.languageConfidence === 'number' && Number.isFinite(value.languageConfidence)
      && value.languageConfidence >= 0 && value.languageConfidence <= 1
      ? { languageConfidence: value.languageConfidence } : {}),
    ...(value.ambiguityReason === 'language' || value.ambiguityReason === 'abbreviation'
      ? { ambiguityReason: value.ambiguityReason } : {}),
  };
}

export function needsForeignWordLanguageReview(value: ForeignWordLanguageMetadata): boolean {
  return value.detectedLanguage === 'unknown' || Boolean(value.ambiguityReason)
    || (value.languageConfidence !== undefined && value.languageConfidence < 0.7);
}

export function isContextualDefinitionLanguage(language: ForeignWordLanguage | undefined): boolean {
  return Boolean(language && !['english', 'other', 'unknown'].includes(language));
}

export const FOREIGN_WORD_LANGUAGE_INSTRUCTIONS = `Identify detectedLanguage from the exact spelling AND supplied passage, not script alone. Use one of: ${Object.keys(FOREIGN_WORD_LANGUAGES).join(', ')}. Return languageConfidence from 0 to 1. Greek script can be Koine or Modern Greek; Hebrew script can be Hebrew or Aramaic; Cyrillic can be Russian, Church Slavonic or another language. Never infer a specific language solely from its script.
When language or an abbreviation's reading is uncertain, use detectedLanguage unknown, ambiguityReason language or abbreviation, sourceOutcome insufficient_context, no pronunciation, and needsReview true. Do not expand abbreviations without passage evidence. Otherwise omit ambiguityReason.
Use Strict Erasmian guidance only for identified Koine Greek and academic Hebrew guidance only for identified Biblical Hebrew. Respect custom profile pronunciation guidance.
For German, French and Latin, use the language's spelling and passage to select a complete English-compatible approximation; do not apply Greek/Hebrew vowel rules. Use nearby author-supplied transliteration for Cyrillic, Arabic, Chinese, Japanese, Aramaic and Geʽez when available; if a reliable reading cannot be established, return insufficient_context. An approximation for an English narrator is not a claim of native-language TTS support.
Ordinary English words and unrelated names accidentally selected as foreign candidates are not_applicable, with no pronunciation or definition. Identified legitimate foreign terms remain valid_word. Preserve the original term key and source evidence.`;
