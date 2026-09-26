import { describe, expect, test } from 'vitest';
import {
  GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
  GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE,
  GOOGLE_CLOUD_TTS_RATE_LIMIT_PAUSE_MESSAGE,
  isGeminiRateLimitPause,
  calculateRemainingDailyQuotaMs,
} from '../../src/lib/shared/audiobook-job-status';

describe('audiobook job status', () => {
  test('distinguishes a Gemini quota pause from a normal error', () => {
    expect(isGeminiRateLimitPause(GEMINI_RATE_LIMIT_PAUSE_MESSAGE)).toBe(true);
    expect(isGeminiRateLimitPause(GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE)).toBe(true);
    expect(isGeminiRateLimitPause(GOOGLE_CLOUD_TTS_RATE_LIMIT_PAUSE_MESSAGE)).toBe(true);
    expect(isGeminiRateLimitPause('Google Cloud TTS returned 429')).toBe(true);
    expect(isGeminiRateLimitPause('Gemini API limits paused generation')).toBe(true);
    expect(isGeminiRateLimitPause('S3 upload failed')).toBe(false);
    expect(isGeminiRateLimitPause(null)).toBe(false);
    expect(isGeminiRateLimitPause(undefined)).toBe(false);
  });

  test('calculateRemainingDailyQuotaMs returns duration between 1h and 24h5m', () => {
    const ms = calculateRemainingDailyQuotaMs();
    expect(ms).toBeGreaterThanOrEqual(3600 * 1000); // at least 1 hour
    expect(ms).toBeLessThanOrEqual((24 * 3600 + 300) * 1000); // at most 24h + 5m
  });
});
