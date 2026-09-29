import { describe, expect, it } from 'vitest';
import type { GeminiVoiceCatalogEntry } from '@/lib/shared/gemini-voice-catalog';
import { recommendAnotherGeminiVoice, recommendGeminiVoices } from '@/lib/shared/gemini-voice-matching';

const voice = (overrides: Partial<GeminiVoiceCatalogEntry>): GeminiVoiceCatalogEntry => ({
  id: 'default', displayName: 'Default', languageCode: 'en-US', regionCode: null,
  accent: null, gender: 'unknown', pitch: 'unknown', persona: null, context: null,
  description: '', type: 'prebuilt', model: null, expireTime: null, ...overrides,
});

const catalog = [
  voice({ id: 'Narrator', displayName: 'Narrator', gender: 'neutral', pitch: 'medium', persona: 'Narrator', context: 'Audiobook', description: 'Clear warm narration' }),
  voice({ id: 'Deep', displayName: 'Deep', gender: 'male', pitch: 'low', persona: 'Authoritative', context: 'Audiobook', description: 'Deep weathered commanding delivery' }),
  voice({ id: 'Bright', displayName: 'Bright', gender: 'female', pitch: 'high', persona: 'Optimistic', context: 'Conversation', description: 'Bright playful delivery' }),
  voice({ id: 'Amber', displayName: 'Amber', gender: 'female', pitch: 'high', persona: 'Warm', context: 'Conversation', description: 'Bright playful delivery' }),
];

describe('recommendGeminiVoices', () => {
  it('matches structured gender and pitch traits', () => {
    const result = recommendGeminiVoices({
      character: { name: 'Alice', importance: 'main', description: '', castingTraits: { genderPresentation: 'female', pitchPreference: 'high' } },
      voices: catalog,
    });
    expect(result.slice(0, 2).map((candidate) => candidate.voice.id)).toEqual(['Amber', 'Bright']);
    expect(result[0].reasons).toContain('female presentation matched');
    expect(result[0].reasons).toContain('high pitch matched');
  });

  it('uses narrator and audiobook metadata for the narrator', () => {
    const result = recommendGeminiVoices({ character: { name: 'Narrator', importance: 'main', description: '' }, voices: catalog });
    expect(result[0].voice.id).toBe('Narrator');
    expect(result[0].reasons).toEqual(expect.arrayContaining(['audiobook context', 'narrator persona']));
  });

  it('penalizes already-used and narrator voices for other main characters', () => {
    const result = recommendGeminiVoices({
      character: { name: 'Gareth', importance: 'main', description: 'weathered commanding man', castingTraits: { genderPresentation: 'male', pitchPreference: 'low' } },
      voices: catalog,
      usedVoiceIds: new Set(['Deep']), narratorVoiceId: 'Narrator',
    });
    expect(result.find((candidate) => candidate.voice.id === 'Deep')?.score).toBeLessThan(recommendGeminiVoices({ character: { name: 'Gareth', importance: 'main', description: 'weathered commanding man', castingTraits: { genderPresentation: 'male', pitchPreference: 'low' } }, voices: catalog }).find((candidate) => candidate.voice.id === 'Deep')!.score);
    expect(result.find((candidate) => candidate.voice.id === 'Narrator')?.score).toBeLessThan(0);
    expect(recommendAnotherGeminiVoice({ character: { name: 'Gareth', importance: 'main', description: '', castingTraits: { genderPresentation: 'female', pitchPreference: 'high' } }, voices: catalog }, new Set(['Amber']))?.voice.id).toBe('Bright');
  });

  it('keeps a manual assignment untouched and has stable tie ordering', () => {
    expect(recommendGeminiVoices({ character: { name: 'Alice', importance: 'main', description: '', voiceAssignment: { provider: 'gemini', voiceId: 'Deep', assignedAt: 0, assignmentSource: 'user' } }, voices: catalog })).toEqual([]);
    const result = recommendGeminiVoices({ character: { name: 'Unknown', importance: 'minor', description: '' }, voices: catalog });
    expect(result.map((candidate) => candidate.voice.displayName)).toEqual(['Deep', 'Narrator', 'Amber', 'Bright']);
  });
});
