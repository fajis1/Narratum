import { isGeminiRateLimitPause, isSystemResourcePause } from '@/lib/shared/audiobook-job-status';

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
 * - Any finite nextAttemptAt is authoritative, regardless of provider/message.
 * - Legacy rate-limit jobs without a timestamp retain their 24-hour backoff.
 * - Manual resume must explicitly clear obsolete retry metadata.
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
    if (typeof settings?.nextAttemptAt === 'number' && Number.isFinite(settings.nextAttemptAt)) {
      return settings.nextAttemptAt <= now;
    }
    if (isGeminiRateLimitPause(row.error)) {
      if (typeof settings?.nextAttemptAt === 'number') {
        return settings.nextAttemptAt <= now;
      }
      return row.updatedAt < backoffThreshold;
    }
    if (isSystemResourcePause(row.error)) {
      return true;
    }
    return true;
  } catch {
    return true;
  }
}
