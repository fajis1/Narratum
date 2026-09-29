import { describe, expect, it } from 'vitest';
import { getGeminiTtsCharacterMapReadiness, normalizeGeminiTtsCharacterMap } from '@/lib/server/smart-audio/gemini-cast-helpers';

const completeMap = (voiceId: string) => ({
  schemaVersion: 1,
  status: 'complete',
  scannedAt: 1,
  entries: {
    Narrator: { name: 'Narrator', description: 'Narrates', sampleText: 'Once', importance: 'main', voiceId },
  },
});

const catalog = {
  source: 'live' as const,
  fetchedAt: 2,
  catalogVersion: 'catalog-v1',
  languageCodes: ['en-US'],
  voices: [{ id: 'new-gemini-voice', displayName: 'New Gemini Voice', languageCode: 'en-US', regionCode: null, accent: null, gender: 'neutral' as const, pitch: 'medium' as const, persona: 'Narrator', context: 'Audiobook', description: null, type: 'prebuilt' as const, model: null, expireTime: null }],
};

describe('Gemini catalog-aware cast helpers', () => {
  it('preserves a safe stored dynamic voice ID while catalog availability is being resolved', () => {
    expect(normalizeGeminiTtsCharacterMap(completeMap('new-gemini-voice'))?.entries.Narrator.voiceId).toBe('new-gemini-voice');
    expect(normalizeGeminiTtsCharacterMap(completeMap('bad voice id!'))?.entries.Narrator.voiceId).toBeNull();
  });

  it('uses the resolved catalog for readiness rather than the retired fixed set', async () => {
    const ready = await getGeminiTtsCharacterMapReadiness({ value: completeMap('new-gemini-voice'), apiKey: 'not-used', resolveCatalog: async () => catalog });
    expect(ready.ready).toBe(true);
    expect(ready.catalog).toMatchObject({ source: 'live', catalogVersion: 'catalog-v1' });

    const invalid = await getGeminiTtsCharacterMapReadiness({ value: completeMap('unknown-voice'), apiKey: 'not-used', resolveCatalog: async () => catalog });
    expect(invalid.ready).toBe(false);
    expect(invalid.unassignedMain).toEqual(['Narrator']);
  });
});