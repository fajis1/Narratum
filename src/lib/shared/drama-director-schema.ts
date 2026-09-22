/** Controlled choices shared by the Drama Director and Cloud TTS pipeline. */
export const DRAMA_UTTERANCE_TYPES = [
  'narration', 'spoken-dialogue', 'internal-thought', 'squad-link',
] as const;
export type DramaUtteranceType = (typeof DRAMA_UTTERANCE_TYPES)[number];

export const DRAMA_PRIMARY_EMOTIONS = [
  'neutral', 'calm', 'serious', 'thoughtful', 'curious', 'uncertain', 'anxious',
  'afraid', 'terrified', 'desperate', 'vulnerable', 'sad', 'grieving', 'hopeful',
  'relieved', 'caring', 'amused', 'mischievous', 'surprised', 'awed', 'excited',
  'triumphant', 'annoyed', 'frustrated', 'angry', 'determined', 'confident',
  'tired', 'bored', 'weary', 'irritated', 'playful', 'eager', 'protective',
] as const;
export type DramaPrimaryEmotion = (typeof DRAMA_PRIMARY_EMOTIONS)[number];

export const DRAMA_SECONDARY_EMOTIONS = DRAMA_PRIMARY_EMOTIONS;
export type DramaSecondaryEmotion = (typeof DRAMA_SECONDARY_EMOTIONS)[number];

export const DRAMA_SOCIAL_INTENTS = [
  'none', 'informing', 'questioning', 'commanding', 'persuasive', 'comforting',
  'challenging', 'confessing', 'reassuring', 'encouraging', 'teasing',
  'bantering', 'celebrating', 'complaining',
] as const;
export type DramaSocialIntent = (typeof DRAMA_SOCIAL_INTENTS)[number];

export const DRAMA_DELIVERY_STYLES = [
  'natural', 'intimate', 'restrained', 'soft', 'sarcastic', 'halting', 'stunned',
  'measured', 'authoritative', 'dramatic', 'matter-of-fact', 'comforting',
  'thoughtful', 'warm', 'calm', 'forceful', 'urgent', 'breathy', 'dry',
] as const;
export type DramaDeliveryStyle = (typeof DRAMA_DELIVERY_STYLES)[number];

export const DRAMA_PACING = [
  'slow', 'slightly-slow', 'measured', 'normal', 'slightly-fast', 'fast',
] as const;
export type DramaPace = (typeof DRAMA_PACING)[number];

export const DRAMA_ENERGY = ['low', 'normal', 'moderate', 'elevated', 'high'] as const;
export type DramaEnergy = (typeof DRAMA_ENERGY)[number];

export const DRAMA_INTENSITY = [
  'low', 'subdued', 'controlled', 'medium', 'moderate', 'building',
  'heightened', 'high', 'intense',
] as const;
export type DramaIntensity = (typeof DRAMA_INTENSITY)[number];

/** Localized markup permitted by the Cloud TTS client. */
export const DRAMA_ONE_SHOT_TAGS = ['sigh', 'laughing', 'uhm'] as const;
export const DRAMA_STYLE_TAGS = [
  'sarcasm', 'robotic', 'shouting', 'whispering', 'extremely fast',
] as const;
export const DRAMA_PAUSE_TAGS = ['short pause', 'medium pause', 'long pause'] as const;
export const DRAMA_AUDIO_TAG_ALLOWLIST = [
  ...DRAMA_ONE_SHOT_TAGS, ...DRAMA_STYLE_TAGS, ...DRAMA_PAUSE_TAGS,
] as const;
export type DramaAudioTag = (typeof DRAMA_AUDIO_TAG_ALLOWLIST)[number];

export interface DramaDirectorPerformance {
  primaryEmotion: DramaPrimaryEmotion;
  secondaryEmotions: DramaSecondaryEmotion[];
  socialIntent: DramaSocialIntent;
  delivery: DramaDeliveryStyle[];
  pace: DramaPace;
  energy: DramaEnergy;
  intensity: DramaIntensity;
  tags: DramaAudioTag[];
  nuance?: string;
}

/** A directed slice of authoritative spoken text. Runtime validation follows in Stage 7. */
export interface DramaDirectorSegment {
  speaker: string;
  utteranceType: DramaUtteranceType;
  text: string;
  sceneContext: string;
  performance: DramaDirectorPerformance;
  omit_from_audio: boolean;
}
