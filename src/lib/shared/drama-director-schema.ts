/** Controlled choices shared by the Drama Director and Cloud TTS pipeline. */
export const DRAMA_UTTERANCE_TYPES = [
  'narration', 'spoken-dialogue', 'internal-thought', 'squad-link',
] as const;
export type DramaUtteranceType = (typeof DRAMA_UTTERANCE_TYPES)[number];

export const DRAMA_PRIMARY_EMOTIONS = [
  'neutral',
  'happy', 'joyful', 'delighted', 'excited', 'enthusiastic', 'eager', 'amused', 'playful',
  'mischievous', 'hopeful', 'optimistic', 'relieved', 'proud', 'triumphant', 'grateful',
  'content', 'inspired', 'awed', 'admiring',
  'affectionate', 'adoring', 'loving', 'tender', 'passionate', 'romantic', 'flirtatious',
  'caring', 'comforting', 'protective', 'devoted', 'yearning', 'longing', 'vulnerable',
  'uneasy', 'nervous', 'anxious', 'worried', 'apprehensive', 'fearful', 'scared',
  'terrified', 'panicked', 'alarmed', 'startled', 'shocked', 'horrified', 'paranoid',
  'suspicious', 'tense', 'dread-filled', 'desperate', 'afraid',
  'annoyed', 'irritated', 'frustrated', 'agitated', 'angry', 'furious', 'enraged',
  'aggressive', 'hostile', 'resentful', 'bitter', 'defiant', 'confrontational',
  'threatening', 'menacing', 'contemptuous', 'disgusted', 'indignant',
  'sad', 'hurt', 'disappointed', 'lonely', 'melancholic', 'grieving', 'heartbroken',
  'hopeless', 'regretful', 'remorseful', 'ashamed', 'guilty', 'tearful',
  'emotionally-broken', 'mourning',
  'curious', 'confused', 'uncertain', 'hesitant', 'skeptical', 'thoughtful',
  'reflective', 'contemplative', 'bewildered', 'distracted', 'surprised', 'intrigued',
  'calm', 'serious', 'solemn', 'focused', 'determined', 'resolute', 'confident',
  'authoritative', 'commanding', 'stoic', 'restrained', 'reverent', 'courageous',
  'sarcastic', 'dry', 'mocking', 'teasing', 'smug', 'arrogant', 'condescending',
  'dismissive', 'embarrassed', 'awkward', 'shy', 'deceptive', 'secretive',
  'tired', 'exhausted', 'weary', 'bored', 'reluctant', 'apathetic', 'sleepy',
  'weak', 'fading', 'breathless', 'injured',
] as const;
export type DramaPrimaryEmotion = (typeof DRAMA_PRIMARY_EMOTIONS)[number];

export const DRAMA_SECONDARY_EMOTIONS = DRAMA_PRIMARY_EMOTIONS;
export type DramaSecondaryEmotion = (typeof DRAMA_SECONDARY_EMOTIONS)[number];

export const DRAMA_SOCIAL_INTENTS = [
  'none', 'neutral', 'informing', 'questioning', 'reassuring', 'friendly', 'comforting',
  'encouraging', 'protective', 'affectionate', 'romantic', 'flirtatious', 'persuasive',
  'pleading', 'apologetic', 'confessing', 'deceptive', 'secretive', 'warning',
  'suspicious', 'challenging', 'accusatory', 'mocking', 'taunting', 'dismissive',
  'intimidating', 'threatening', 'commanding', 'dominating', 'defiant',
  'negotiating', 'comfort-seeking', 'teasing', 'bantering', 'celebrating', 'complaining',
] as const;
export type DramaSocialIntent = (typeof DRAMA_SOCIAL_INTENTS)[number];

export const DRAMA_DELIVERY_STYLES = [
  'natural', 'conversational', 'intimate', 'gentle', 'soft', 'breathy', 'hushed',
  'whispered', 'restrained', 'measured', 'deliberate', 'careful', 'dramatic',
  'theatrical', 'urgent', 'forceful', 'commanding', 'shouted', 'trembling',
  'voice-breaking', 'matter-of-fact', 'deadpan', 'sarcastic', 'secretive',
  'menacing', 'comforting', 'pleading', 'accusatory', 'taunting', 'stunned',
  'breathless', 'halting', 'confident', 'authoritative', 'thoughtful', 'warm',
  'calm', 'dry',
] as const;
export type DramaDeliveryStyle = (typeof DRAMA_DELIVERY_STYLES)[number];

export const DRAMA_PACING = [
  'very-slow', 'slow', 'slightly-slow', 'measured', 'normal', 'slightly-fast',
  'fast', 'very-fast', 'rushed', 'accelerating', 'decelerating', 'irregular', 'hesitant',
] as const;
export type DramaPace = (typeof DRAMA_PACING)[number];

export const DRAMA_ENERGY = [
  'very-low', 'low', 'subdued', 'normal', 'moderate', 'elevated', 'high', 'explosive',
] as const;
export type DramaEnergy = (typeof DRAMA_ENERGY)[number];

export const DRAMA_INTENSITY = [
  'very-low', 'low', 'subdued', 'controlled', 'medium', 'moderate', 'building',
  'fading', 'heightened', 'high', 'very-high', 'intense',
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
