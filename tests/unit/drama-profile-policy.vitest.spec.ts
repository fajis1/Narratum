import { describe, expect, test } from 'vitest';
import { validateDramaDirectorOutput } from '@/lib/server/smart-audio/drama-director';
import { buildDramaDirectorPolicy } from '@/lib/shared/drama-profile-settings';

const output = {
  segments: [{
    speaker: 'Narrator',
    utteranceType: 'narration',
    text: 'A door opened.',
    sceneContext: 'The room is quiet.',
    omit_from_audio: false,
    performance: {
      primaryEmotion: 'calm',
      secondaryEmotions: [],
      socialIntent: 'none',
      delivery: ['natural'],
      pace: 'normal',
      energy: 'low',
      intensity: 'controlled',
      tags: ['shouting', 'long pause', 'sigh'],
    },
  }],
};

describe('Drama profile policy enforcement', () => {
  test('audioTagUsage off removes all Director tags', () => {
    const result = validateDramaDirectorOutput({
      sourceText: 'A door opened.',
      castNames: ['Narrator'],
      output,
      policy: buildDramaDirectorPolicy({ audioTagUsage: 'off' }),
    });
    expect(result[0].performance.tags).toEqual([]);
  });

  test('conservative usage keeps the production allowlist and limits tag density', () => {
    const result = validateDramaDirectorOutput({
      sourceText: 'A door opened.',
      castNames: ['Narrator'],
      output,
      policy: buildDramaDirectorPolicy({ audioTagUsage: 'conservative' }),
    });
    expect(result[0].performance.tags).toEqual(['shouting']);
  });

  test('natural pause policy removes long pauses while preserving source text', () => {
    const result = validateDramaDirectorOutput({
      sourceText: 'A door opened.',
      castNames: ['Narrator'],
      output,
      policy: buildDramaDirectorPolicy({ audioTagUsage: 'balanced', dramaticPauses: 'natural' }),
    });
    expect(result[0].performance.tags).not.toContain('long pause');
    expect(result[0].text).toBe('A door opened.');
  });
});
