import { describe, expect, test } from 'vitest';
import { readAudiobookProviderRetry } from '@/lib/shared/audiobook-provider-retry';
import { resolveAudiobookJobDescriptiveState } from '@/lib/shared/audiobook-job-status';

const schedule = {
  nextAttemptAt: 1_800_000_300_000,
  providerRetry: { count: 1, exhausted: false, nextAttemptAt: 1_800_000_600_000,
    failure: { provider: 'gemini', model: 'gemini-3.8-flash', httpStatus: 429, stage: 'targeted_pronunciation_repair' } },
};

describe('durable provider retry display', () => {
  test('uses the authoritative queued schedule, including JSON settings, rather than diagnostic timestamps', () => {
    expect(readAudiobookProviderRetry(schedule, 'queued')).toEqual({ nextAttemptAt: schedule.nextAttemptAt, providerLabel: 'Gemini' });
    expect(readAudiobookProviderRetry(JSON.stringify(schedule), 'queued')).toEqual(readAudiobookProviderRetry(schedule, 'queued'));
    expect(readAudiobookProviderRetry({ providerRetry: schedule.providerRetry }, 'queued')).toBeNull();
    expect(readAudiobookProviderRetry({ previousAttempts: [schedule] }, 'queued')).toBeNull();
    expect(readAudiobookProviderRetry({ ...schedule, nextAttemptAt: null }, 'queued')).toBeNull();
  });

  test.each(['running', 'paused', 'pause_requested', 'cancelled', 'completed', 'error'])('hides stale schedules for %s jobs', status => {
    expect(readAudiobookProviderRetry(schedule, status)).toBeNull();
  });

  test('rejects invalid dates, exhausted retries and malformed settings without throwing', () => {
    for (const nextAttemptAt of [NaN, Infinity, -1, 8.64e15 + 1, '1800000300000']) {
      expect(readAudiobookProviderRetry({ ...schedule, nextAttemptAt }, 'queued')).toBeNull();
    }
    for (const settings of [undefined, null, [], 'invalid json', 'null',
      { ...schedule, providerRetry: { ...schedule.providerRetry, exhausted: true } },
      { ...schedule, providerRetry: null }, { ...schedule, providerRetry: { failure: null } }]) {
      expect(readAudiobookProviderRetry(settings, 'queued')).toBeNull();
    }
  });

  test('retains provider-wait status after the scheduled time while the job is still queued', () => {
    expect(resolveAudiobookJobDescriptiveState({ status: 'queued', settingsJson: { ...schedule, nextAttemptAt: 1 } }))
      .toMatchObject({ category: 'waiting', badgeText: 'Waiting for Gemini', isPaused: false });
    expect(resolveAudiobookJobDescriptiveState({ status: 'running', settingsJson: schedule }))
      .toMatchObject({ category: 'running', badgeText: 'Running' });
  });

  test('labels Kokoro retries and avoids displaying unsafe provider strings', () => {
    expect(readAudiobookProviderRetry({ ...schedule, providerRetry: { failure: { provider: 'custom-openai', model: 'kokoro' } } }, 'queued'))
      .toMatchObject({ providerLabel: 'Kokoro' });
    expect(readAudiobookProviderRetry({ ...schedule, providerRetry: { failure: { provider: 'https://private?key=fixture' } } }, 'queued'))
      .toMatchObject({ providerLabel: 'provider' });
  });
});
