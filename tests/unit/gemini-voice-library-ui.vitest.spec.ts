import { describe, expect, it } from 'vitest';
import {
  filterGeminiVoiceLibrary,
  formatGeminiAssignmentReason,
  listGeminiVoiceMetadataValues,
} from '@/lib/shared/gemini-voice-library-ui';
import type { GeminiVoiceCatalogEntry } from '@/lib/shared/gemini-voice-catalog';

const voice = (id: string, extra: Partial<GeminiVoiceCatalogEntry>): GeminiVoiceCatalogEntry => ({
  id, displayName: id, languageCode: 'en-US', regionCode: null, accent: null, gender: 'unknown', pitch: 'unknown',
  persona: null, context: null, description: null, type: 'prebuilt', model: null, expireTime: null, ...extra,
});
const voices = [
  voice('Algenib', { gender: 'male', pitch: 'low', accent: 'American', persona: 'Gravelly', context: 'Audiobook', description: 'Deep textured narration' }),
  voice('Bright', { gender: 'female', pitch: 'high', accent: 'British', persona: 'Warm', context: 'Conversational', description: 'Bright dialogue' }),
  voice('Neutral', { gender: 'neutral', pitch: 'medium', accent: 'American', persona: 'Measured', context: 'Narration', description: 'Measured and clear' }),
];
const filters = { query: '', gender: 'all' as const, pitch: 'all' as const, accent: 'all', context: 'all', hideUsed: false };

describe('Gemini Voice Library filters', () => {
  it('filters by search, gender including neutral, pitch, accent, context, and used state', () => {
    expect(filterGeminiVoiceLibrary(voices, { ...filters, query: 'textured' }, new Set()).map((voice) => voice.id)).toEqual(['Algenib']);
    expect(filterGeminiVoiceLibrary(voices, { ...filters, gender: 'neutral' }, new Set()).map((voice) => voice.id)).toEqual(['Neutral']);
    expect(filterGeminiVoiceLibrary(voices, { ...filters, pitch: 'high' }, new Set()).map((voice) => voice.id)).toEqual(['Bright']);
    expect(filterGeminiVoiceLibrary(voices, { ...filters, accent: 'American' }, new Set()).map((voice) => voice.id)).toEqual(['Algenib', 'Neutral']);
    expect(filterGeminiVoiceLibrary(voices, { ...filters, context: 'Audiobook' }, new Set()).map((voice) => voice.id)).toEqual(['Algenib']);
    expect(filterGeminiVoiceLibrary(voices, { ...filters, hideUsed: true }, new Set(['Bright'])).map((voice) => voice.id)).toEqual(['Algenib', 'Neutral']);
  });

  it('keeps the current voice visible even if every active filter excludes it', () => {
    expect(filterGeminiVoiceLibrary(voices, { ...filters, gender: 'male', pitch: 'low', accent: 'American', context: 'Audiobook', hideUsed: true, currentVoiceId: 'Bright' }, new Set(['Bright'])).map((voice) => voice.id)).toEqual(['Algenib', 'Bright']);
  });

  it('discovers metadata filters and formats saved assignment reasons for people', () => {
    expect(listGeminiVoiceMetadataValues(voices, 'context')).toEqual(['Audiobook', 'Conversational', 'Narration']);
    expect(formatGeminiAssignmentReason({ assignmentSource: 'user', reason: 'internal text' })).toBe('Selected by you');
    expect(formatGeminiAssignmentReason({ assignmentSource: 'prescan-recommendation', reason: 'Gemini catalog recommendation: low pitch matched; audiobook context.' })).toBe('low pitch matched; audiobook context.');
  });
});
