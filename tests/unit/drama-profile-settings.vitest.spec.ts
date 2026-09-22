import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DRAMA_GEMINI_TTS_SETTINGS,
  buildDramaDirectorPolicy,
  normalizeDramaGeminiTtsProfileSettings,
} from '@/lib/shared/drama-profile-settings';

describe('Google Cloud Drama profile settings', () => {
  test('applies the safe defaults to missing settings', () => {
    expect(normalizeDramaGeminiTtsProfileSettings(undefined)).toEqual(DEFAULT_DRAMA_GEMINI_TTS_SETTINGS);
  });

  test('normalizes invalid enum values without rejecting the profile', () => {
    expect(normalizeDramaGeminiTtsProfileSettings({ dramaStyle: 'theatrical', languageCode: 'not a locale' })).toEqual(DEFAULT_DRAMA_GEMINI_TTS_SETTINGS);
  });

  test('preserves valid settings through a persistence-shaped round trip', () => {
    const input = { ...DEFAULT_DRAMA_GEMINI_TTS_SETTINGS, dramaStyle: 'cinematic', languageCode: 'en-GB', failedSegmentBehavior: 'stop-job' } as const;
    expect(normalizeDramaGeminiTtsProfileSettings(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  test('builds one deterministic Director policy', () => {
    const policy = buildDramaDirectorPolicy({ characterExpressiveness: 'dramatic', narratorExpressiveness: 'subtle', audioTagUsage: 'off' });
    expect(policy).toMatchObject({
      overallStyle: 'balanced',
      narratorPerformance: { expressiveness: 'subtle' },
      characterPerformance: { expressiveness: 'dramatic', consistency: 'strong' },
      tags: { usage: 'off', pauseStyle: 'natural' },
      languageCode: 'en-US',
    });
  });

  test('keeps narrator and character expressiveness separate', () => {
    const policy = buildDramaDirectorPolicy({ narratorExpressiveness: 'subtle', characterExpressiveness: 'dramatic' });
    expect(policy.narratorPerformance.expressiveness).toBe('subtle');
    expect(policy.characterPerformance.expressiveness).toBe('dramatic');
  });

  test('accepts supported BCP-47-style language codes', () => {
    expect(normalizeDramaGeminiTtsProfileSettings({ languageCode: 'fr-FR' }).languageCode).toBe('fr-FR');
  });

  test('rejects empty or malformed language codes to en-US', () => {
    expect(normalizeDramaGeminiTtsProfileSettings({ languageCode: '' }).languageCode).toBe('en-US');
    expect(normalizeDramaGeminiTtsProfileSettings({ languageCode: 'English' }).languageCode).toBe('en-US');
  });

  test('normalizes failure behavior to continue-and-flag by default', () => {
    expect(normalizeDramaGeminiTtsProfileSettings({ failedSegmentBehavior: 'ignore' }).failedSegmentBehavior).toBe('continue-and-flag');
    expect(normalizeDramaGeminiTtsProfileSettings({ failedSegmentBehavior: 'stop-job' }).failedSegmentBehavior).toBe('stop-job');
  });
});
