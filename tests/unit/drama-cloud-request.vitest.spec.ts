import { describe, expect, it } from 'vitest';
import { buildDramaCloudTtsRequest } from '../../src/lib/server/smart-audio/drama-cloud-request';
import type { DramaDirectorSegment } from '../../src/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '../../src/types/document-settings';

const segment: DramaDirectorSegment = {
  speaker: 'Bethany', utteranceType: 'squad-link', text: 'We should go.',
  sceneContext: 'The squad is planning its next move.', omit_from_audio: false,
  performance: {
    primaryEmotion: 'determined', secondaryEmotions: ['uncertain'],
    socialIntent: 'encouraging', delivery: ['restrained'], pace: 'measured',
    energy: 'low', intensity: 'high', tags: ['sigh'],
  },
};
const characterMap: SmartAudioCharacterMap = {
  schemaVersion: 1, status: 'complete', scannedAt: 1,
  entries: {
    Bethany: {
      name: 'Bethany', description: 'A steady leader.', sampleText: '', voiceId: 'Kore',
      cloudDirection: {
        audioProfile: 'Warm and quietly authoritative.',
        defaultPerformance: { pace: 'measured', energy: 'low' },
        technicalOverrides: { speakingRate: 0.9, pitch: -1 },
      },
    },
    Beth: { name: 'Beth', description: '', sampleText: '', aliasFor: 'Bethany' },
  },
};

describe('Drama Cloud TTS request builder', () => {
  it('resolves cast voice and produces the documented REST body', () => {
    const result = buildDramaCloudTtsRequest({ segment, characterMap });
    expect(result.request).toMatchObject({
      input: { text: 'We should go.' },
      voice: { name: 'Kore', languageCode: 'en-US', modelName: 'gemini-3.1-flash-tts-preview' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 0.9, pitch: -1 },
    });
    expect(result.request).not.toHaveProperty('styleInstructions');
    expect(result.request.input.prompt).toContain('Warm and quietly authoritative.');
    expect(result.request.input.prompt).toContain('emotional intensity high');
    expect(result.request.input.prompt).toContain('energy low');
    expect(result.request.input.text).toBe(segment.text);
    expect(result.deferredTags).toEqual(['sigh']);
  });

  it('uses the primary character direction for an alias', () => {
    const result = buildDramaCloudTtsRequest({ segment: { ...segment, speaker: 'Beth' }, characterMap });
    expect(result.request.voice.name).toBe('Kore');
    expect(result.request.input.prompt).toContain('Warm and quietly authoritative.');
  });

  it('rejects an invalid cast, omitted segment, and source tags that would be stripped', () => {
    expect(() => buildDramaCloudTtsRequest({ segment: { ...segment, speaker: 'Unknown' }, characterMap })).toThrow(/reviewed cast/);
    expect(() => buildDramaCloudTtsRequest({ segment: { ...segment, omit_from_audio: true }, characterMap })).toThrow(/omitted/);
    expect(() => buildDramaCloudTtsRequest({ segment: { ...segment, text: '[quest] Go.' }, characterMap })).toThrow(/remove/);
  });

  it('checks final UTF-8 text and prompt byte limits', () => {
    expect(() => buildDramaCloudTtsRequest({ segment: { ...segment, text: '😀'.repeat(901) }, characterMap })).toThrow(/safe limit/);
    const longMap = structuredClone(characterMap);
    longMap.entries.Bethany.cloudDirection!.audioProfile = 'A'.repeat(3700);
    expect(() => buildDramaCloudTtsRequest({ segment, characterMap: longMap })).toThrow(/safe limit/);
  });

  it('rejects technical overrides outside the current Cloud API range', () => {
    const badMap = structuredClone(characterMap);
    badMap.entries.Bethany.cloudDirection!.technicalOverrides!.speakingRate = 4;
    expect(() => buildDramaCloudTtsRequest({ segment, characterMap: badMap })).toThrow(/0.25 and 2.0/);
  });
});
