export const GEMINI_RATE_LIMIT_PAUSE_MESSAGE =
  'Gemini API limits paused this audiobook. Completed chapters are preserved, and OpenReader will retry automatically when API capacity becomes available.';

export const GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE =
  'Google Cloud TTS daily quota or credits exhausted. Completed chapters are preserved, and OpenReader will automatically resume after the daily refresh cycle.';

export const GOOGLE_CLOUD_TTS_RATE_LIMIT_PAUSE_MESSAGE =
  'Google Cloud TTS rate limits paused this audiobook. Completed chapters are preserved, and OpenReader will retry automatically after a cooldown.';

export const AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS = 'pausing';

export function isGeminiRateLimitPause(error: string | null | undefined): boolean {
  if (!error) return false;
  return error === GEMINI_RATE_LIMIT_PAUSE_MESSAGE
    || error === GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE
    || error === GOOGLE_CLOUD_TTS_RATE_LIMIT_PAUSE_MESSAGE
    || error.startsWith('Google Cloud TTS')
    || error.startsWith('Gemini API limits paused');
}

/**
 * Calculates remaining milliseconds until the next daily quota refresh.
 * Google Cloud and Gemini daily quotas refresh at midnight Pacific Time (America/Los_Angeles).
 * Returns the milliseconds until the next 00:05 PT (with a 5-minute safety buffer),
 * bounded between 1 hour (3600s) and 24 hours + 5 minutes.
 */
export function calculateRemainingDailyQuotaMs(now: number = Date.now()): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(now));
    const getPart = (type: string) => parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
    const hour = getPart('hour');
    const minute = getPart('minute');
    const second = getPart('second');

    // Seconds elapsed today in Pacific Time:
    const secondsElapsedToday = (hour % 24) * 3600 + minute * 60 + second;
    const secondsUntilMidnight = 86400 - secondsElapsedToday;

    // Add 5 minutes (300s) buffer after midnight PT so Google's backend has completed the reset:
    const msUntilRefresh = (secondsUntilMidnight + 300) * 1000;

    return Math.max(3600 * 1000, Math.min(msUntilRefresh, (24 * 3600 + 300) * 1000));
  } catch {
    return 24 * 60 * 60 * 1000;
  }
}
