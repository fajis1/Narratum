import { describe, expect, it } from 'vitest';

import {
  DRAMA_AUDIO_TAG_ALLOWLIST,
  DRAMA_DELIVERY_STYLES,
  DRAMA_ENERGY,
  DRAMA_INTENSITY,
  DRAMA_ONE_SHOT_TAGS,
  DRAMA_PACING,
  DRAMA_PAUSE_TAGS,
  DRAMA_PRIMARY_EMOTIONS,
  DRAMA_SECONDARY_EMOTIONS,
  DRAMA_SOCIAL_INTENTS,
  DRAMA_STYLE_TAGS,
  DRAMA_UTTERANCE_TYPES,
} from '../../src/lib/shared/drama-director-schema';
import { DRAMA_ALLOWED_TAG_SET } from '../../src/lib/server/smart-audio/google-cloud-tts-client';
import type { DramaDirectorSegment } from '../../src/lib/shared/drama-director-schema';

describe('Drama Director schema', () => {
  it('covers the four utterance types and author-specific social intents', () => {
    expect(DRAMA_UTTERANCE_TYPES).toEqual([
      'narration', 'spoken-dialogue', 'internal-thought', 'squad-link',
    ]);
    expect(DRAMA_SOCIAL_INTENTS).toEqual(expect.arrayContaining([
      'teasing', 'bantering', 'celebrating', 'complaining',
    ]));
  });

  it('covers the author examples and default character direction choices', () => {
    for (const value of ['desperate', 'uncertain', 'anxious', 'mischievous', 'awed', 'surprised', 'annoyed', 'serious', 'excited', 'frustrated', 'determined', 'calm']) {
      expect(DRAMA_PRIMARY_EMOTIONS).toContain(value);
    }
    for (const value of ['vulnerable', 'hopeful', 'protective', 'weary', 'worried', 'reflective']) {
      expect(DRAMA_SECONDARY_EMOTIONS).toContain(value);
    }
    for (const value of ['intimate', 'restrained', 'matter-of-fact', 'authoritative', 'warm']) {
      expect(DRAMA_DELIVERY_STYLES).toContain(value);
    }
    expect(DRAMA_PACING).toContain('slightly-fast');
    expect(DRAMA_ENERGY).toContain('elevated');
    expect(DRAMA_INTENSITY).toContain('building');
  });

  it('includes the original plan vocabulary without duplicate choices', () => {
    expect(DRAMA_PRIMARY_EMOTIONS).toEqual(expect.arrayContaining(['passionate', 'fearful', 'tense', 'contemptuous', 'worried', 'reflective']));
    expect(DRAMA_SOCIAL_INTENTS).toEqual(expect.arrayContaining(['warning', 'protective', 'intimidating']));
    expect(DRAMA_DELIVERY_STYLES).toEqual(expect.arrayContaining(['whispered', 'trembling', 'menacing']));
    expect(DRAMA_PACING).toContain('accelerating');
    expect(DRAMA_ENERGY).toContain('explosive');
    expect(DRAMA_INTENSITY).toContain('very-high');
    for (const choices of [DRAMA_PRIMARY_EMOTIONS, DRAMA_SOCIAL_INTENTS, DRAMA_DELIVERY_STYLES, DRAMA_PACING, DRAMA_ENERGY, DRAMA_INTENSITY]) {
      expect(new Set(choices).size).toBe(choices.length);
    }
  });

  it('shares the exact Cloud TTS tag allowlist', () => {
    expect(DRAMA_AUDIO_TAG_ALLOWLIST).toEqual([
      ...DRAMA_ONE_SHOT_TAGS, ...DRAMA_STYLE_TAGS, ...DRAMA_PAUSE_TAGS,
    ]);
    expect(new Set(DRAMA_AUDIO_TAG_ALLOWLIST)).toEqual(DRAMA_ALLOWED_TAG_SET);
    expect(DRAMA_ALLOWED_TAG_SET.has('scared')).toBe(false);
  });

  it('types a complete Director segment without a voice choice', () => {
    const segment: DramaDirectorSegment = {
      speaker: 'Bethany',
      utteranceType: 'squad-link',
      text: 'We should go.',
      sceneContext: 'Bethany is speaking to her linked squad.',
      performance: {
        primaryEmotion: 'determined', secondaryEmotions: ['uncertain'],
        socialIntent: 'encouraging', delivery: ['natural'], pace: 'measured',
        energy: 'low', intensity: 'high', tags: [],
      },
      omit_from_audio: false,
    };
    expect(segment.performance.tags).toEqual([]);
  });
});
