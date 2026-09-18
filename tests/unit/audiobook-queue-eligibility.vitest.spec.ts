import { describe, expect, test } from 'vitest';
import { GEMINI_RATE_LIMIT_PAUSE_MESSAGE } from '../../src/lib/shared/audiobook-job-status';
import {
  isAudiobookJobEligibleToRun,
  type AudiobookJobCandidate,
} from '../../src/lib/server/audiobooks/queue-eligibility';

describe('audiobook queue cooperative eligibility', () => {
  const baseTime = 1_700_000_000_000;
  const backoffThreshold = baseTime - 24 * 60 * 60 * 1000;

  test('normal queued job with no errors is eligible to run', () => {
    const job: AudiobookJobCandidate = {
      id: 'job-1',
      error: null,
      updatedAt: baseTime,
      settingsJson: JSON.stringify({ bookLexiconApproved: true }),
    };
    const active = new Set<string>();
    expect(isAudiobookJobEligibleToRun(job, active, baseTime, backoffThreshold)).toBe(true);
  });

  test('job that is currently active in the running pool is skipped', () => {
    const job: AudiobookJobCandidate = {
      id: 'job-1',
      error: null,
      updatedAt: baseTime,
    };
    const active = new Set<string>(['job-1']);
    expect(isAudiobookJobEligibleToRun(job, active, baseTime, backoffThreshold)).toBe(false);
  });

  test('job in cooperative rate limit cooldown is skipped until cooldown expires', () => {
    const active = new Set<string>();
    const coolingJob: AudiobookJobCandidate = {
      id: 'job-cooling',
      error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
      updatedAt: baseTime,
      settingsJson: JSON.stringify({
        nextAttemptAt: baseTime + 300_000, // 5 minutes in future
      }),
    };

    // Before cooldown expires: skipped
    expect(isAudiobookJobEligibleToRun(coolingJob, active, baseTime, backoffThreshold)).toBe(false);

    // Exactly at cooldown expiration: eligible
    expect(isAudiobookJobEligibleToRun(coolingJob, active, baseTime + 300_000, backoffThreshold)).toBe(true);

    // After cooldown expiration: eligible
    expect(isAudiobookJobEligibleToRun(coolingJob, active, baseTime + 300_001, backoffThreshold)).toBe(true);
  });

  test('handles settingsJson as already-parsed object', () => {
    const active = new Set<string>();
    const coolingJob: AudiobookJobCandidate = {
      id: 'job-cooling-obj',
      error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
      updatedAt: baseTime,
      settingsJson: {
        nextAttemptAt: baseTime + 60_000,
      },
    };

    expect(isAudiobookJobEligibleToRun(coolingJob, active, baseTime, backoffThreshold)).toBe(false);
    expect(isAudiobookJobEligibleToRun(coolingJob, active, baseTime + 60_000, backoffThreshold)).toBe(true);
  });

  test('cooperative multi-user queueing allows User B and C to run while User A cools down', () => {
    const active = new Set<string>();

    const userAJob: AudiobookJobCandidate = {
      id: 'user-a-job',
      error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
      updatedAt: baseTime,
      settingsJson: JSON.stringify({ nextAttemptAt: baseTime + 300_000 }),
    };

    const userBJob: AudiobookJobCandidate = {
      id: 'user-b-job',
      error: null,
      updatedAt: baseTime,
      settingsJson: JSON.stringify({ voice: 'af_heart' }),
    };

    const userCJob: AudiobookJobCandidate = {
      id: 'user-c-job',
      error: null,
      updatedAt: baseTime,
      settingsJson: JSON.stringify({ voice: 'am_michael' }),
    };

    // User A is cooling down and yields the slot
    expect(isAudiobookJobEligibleToRun(userAJob, active, baseTime, backoffThreshold)).toBe(false);

    // User B and User C can run concurrently without waiting for User A's cooldown
    expect(isAudiobookJobEligibleToRun(userBJob, active, baseTime, backoffThreshold)).toBe(true);
    expect(isAudiobookJobEligibleToRun(userCJob, active, baseTime, backoffThreshold)).toBe(true);

    // If User B is now claimed and running:
    active.add('user-b-job');
    expect(isAudiobookJobEligibleToRun(userBJob, active, baseTime, backoffThreshold)).toBe(false);
    expect(isAudiobookJobEligibleToRun(userCJob, active, baseTime, backoffThreshold)).toBe(true);
  });

  test('legacy rate-limited jobs without nextAttemptAt adhere to the 24-hour backoff threshold', () => {
    const active = new Set<string>();

    const legacyRecentJob: AudiobookJobCandidate = {
      id: 'legacy-recent',
      error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
      updatedAt: baseTime - 1_000, // Updated 1 second ago (well within 24h)
      settingsJson: JSON.stringify({}),
    };
    expect(isAudiobookJobEligibleToRun(legacyRecentJob, active, baseTime, backoffThreshold)).toBe(false);

    const legacyExpiredJob: AudiobookJobCandidate = {
      id: 'legacy-expired',
      error: GEMINI_RATE_LIMIT_PAUSE_MESSAGE,
      updatedAt: backoffThreshold - 1_000, // Older than 24 hours
      settingsJson: JSON.stringify({}),
    };
    expect(isAudiobookJobEligibleToRun(legacyExpiredJob, active, baseTime, backoffThreshold)).toBe(true);
  });

  test('resumed or requeued job with error cleared to null runs immediately even with stale settingsJson', () => {
    const active = new Set<string>();
    const resumedJob: AudiobookJobCandidate = {
      id: 'resumed-job',
      error: null, // User manually resumed or requeued, resetting error to null
      updatedAt: baseTime,
      settingsJson: JSON.stringify({ nextAttemptAt: baseTime + 300_000 }),
    };
    expect(isAudiobookJobEligibleToRun(resumedJob, active, baseTime, backoffThreshold)).toBe(true);
  });
});
