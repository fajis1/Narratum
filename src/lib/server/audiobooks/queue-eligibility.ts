import { isGeminiRateLimitPause } from '@/lib/shared/audiobook-job-status';

export interface AudiobookJobCandidate {
  id: string;
  error?: string | null;
  updatedAt: number;
  settingsJson?: string | Record<string, unknown> | null;
}

/**
 * Determines whether an audiobook job in 'queued' or 'waiting_for_pdf' status
 * is eligible to be claimed and run immediately.
 * 
 * - Skips jobs already active in the running jobs pool.
 * - If a job encountered a Gemini rate limit and has nextAttemptAt set in settingsJson,
 *   it is paused cooperatively until nextAttemptAt expires, freeing worker slots for other jobs.
 * - If a job encountered a legacy rate limit without nextAttemptAt, it adheres to the 24h backoff.
 * - Otherwise (normal job or manual resume/requeue where error is null), it is immediately eligible.
 */
export function isAudiobookJobEligibleToRun(
  row: AudiobookJobCandidate,
  activeRunningJobIds: Set<string> | Map<string, unknown>,
  now: number = Date.now(),
  backoffThreshold: number = now - 24 * 60 * 60 * 1000
): boolean {
  if (activeRunningJobIds.has(row.id)) return false;
  try {
    const settings = typeof row.settingsJson === 'string' ? JSON.parse(row.settingsJson) : (row.settingsJson || {});
    if (isGeminiRateLimitPause(row.error)) {
      if (typeof settings?.nextAttemptAt === 'number') {
        return settings.nextAttemptAt <= now;
      }
      return row.updatedAt < backoffThreshold;
    }
    return true;
  } catch {
    return true;
  }
}
