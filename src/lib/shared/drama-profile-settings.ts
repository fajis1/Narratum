export type DramaStyle = 'restrained' | 'balanced' | 'cinematic';
export type NarratorExpressiveness = 'subtle' | 'moderate' | 'expressive';
export type CharacterExpressiveness = 'subtle' | 'expressive' | 'dramatic';
export type DramaAudioTagUsage = 'off' | 'conservative' | 'balanced' | 'expressive';
export type DramaPauseStyle = 'minimal' | 'natural' | 'cinematic';
export type CharacterConsistency = 'flexible' | 'balanced' | 'strong';
export type DramaFailedSegmentBehavior = 'continue-and-flag' | 'stop-job';

export interface DramaGeminiTtsProfileSettings {
  dramaStyle: DramaStyle;
  narratorExpressiveness: NarratorExpressiveness;
  characterExpressiveness: CharacterExpressiveness;
  audioTagUsage: DramaAudioTagUsage;
  dramaticPauses: DramaPauseStyle;
  characterConsistency: CharacterConsistency;
  languageCode: string;
  failedSegmentBehavior: DramaFailedSegmentBehavior;
}

export const DEFAULT_DRAMA_GEMINI_TTS_SETTINGS = {
  dramaStyle: 'balanced',
  narratorExpressiveness: 'moderate',
  characterExpressiveness: 'expressive',
  audioTagUsage: 'conservative',
  dramaticPauses: 'natural',
  characterConsistency: 'strong',
  languageCode: 'en-US',
  failedSegmentBehavior: 'continue-and-flag',
} as const satisfies DramaGeminiTtsProfileSettings;

const VALUES = {
  dramaStyle: ['restrained', 'balanced', 'cinematic'],
  narratorExpressiveness: ['subtle', 'moderate', 'expressive'],
  characterExpressiveness: ['subtle', 'expressive', 'dramatic'],
  audioTagUsage: ['off', 'conservative', 'balanced', 'expressive'],
  dramaticPauses: ['minimal', 'natural', 'cinematic'],
  characterConsistency: ['flexible', 'balanced', 'strong'],
  failedSegmentBehavior: ['continue-and-flag', 'stop-job'],
} as const;

function choice<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : fallback;
}

export function normalizeDramaGeminiTtsProfileSettings(value: unknown): DramaGeminiTtsProfileSettings {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const languageCode = typeof source.languageCode === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})+$/u.test(source.languageCode.trim())
    ? source.languageCode.trim()
    : DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.languageCode;
  return {
    dramaStyle: choice(source.dramaStyle, VALUES.dramaStyle, DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.dramaStyle),
    narratorExpressiveness: choice(source.narratorExpressiveness, VALUES.narratorExpressiveness, DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.narratorExpressiveness),
    characterExpressiveness: choice(source.characterExpressiveness, VALUES.characterExpressiveness, DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.characterExpressiveness),
    audioTagUsage: choice(source.audioTagUsage, VALUES.audioTagUsage, DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.audioTagUsage),
    dramaticPauses: choice(source.dramaticPauses, VALUES.dramaticPauses, DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.dramaticPauses),
    characterConsistency: choice(source.characterConsistency, VALUES.characterConsistency, DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.characterConsistency),
    languageCode,
    failedSegmentBehavior: choice(source.failedSegmentBehavior, VALUES.failedSegmentBehavior, DEFAULT_DRAMA_GEMINI_TTS_SETTINGS.failedSegmentBehavior),
  };
}

export interface DramaDirectorPolicy {
  overallStyle: DramaStyle;
  narratorPerformance: { expressiveness: NarratorExpressiveness };
  characterPerformance: { expressiveness: CharacterExpressiveness; consistency: CharacterConsistency };
  tags: { usage: DramaAudioTagUsage; pauseStyle: DramaPauseStyle };
  languageCode: string;
  failedSegmentBehavior: DramaFailedSegmentBehavior;
}

export function buildDramaDirectorPolicy(value: unknown): DramaDirectorPolicy {
  const settings = normalizeDramaGeminiTtsProfileSettings(value);
  return {
    overallStyle: settings.dramaStyle,
    narratorPerformance: { expressiveness: settings.narratorExpressiveness },
    characterPerformance: {
      expressiveness: settings.characterExpressiveness,
      consistency: settings.characterConsistency,
    },
    tags: { usage: settings.audioTagUsage, pauseStyle: settings.dramaticPauses },
    languageCode: settings.languageCode,
    failedSegmentBehavior: settings.failedSegmentBehavior,
  };
}

