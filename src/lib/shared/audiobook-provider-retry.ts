import { isKokoroModel } from './kokoro';

export interface AudiobookProviderRetrySchedule {
  nextAttemptAt: number;
  providerLabel: string;
}

/** Only a queued job's top-level timestamp schedules work; diagnostic timestamps are history. */
export function readAudiobookProviderRetry(value: unknown, status: string): AudiobookProviderRetrySchedule | null {
  if (status !== 'queued') return null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  if (typeof settings.nextAttemptAt !== 'number' || !Number.isFinite(settings.nextAttemptAt)
      || settings.nextAttemptAt < 0 || settings.nextAttemptAt > 8.64e15) return null;
  const retry = settings.providerRetry;
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) return null;
  const details = retry as Record<string, unknown>;
  if (details.exhausted === true) return null;
  const failure = details.failure;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return null;
  const { provider, model } = failure as Record<string, unknown>;
  const providerLabel = isKokoroModel(typeof model === 'string' ? model : undefined) ? 'Kokoro'
    : provider === 'gemini' ? 'Gemini'
      : typeof provider === 'string' && /^[a-zA-Z0-9._-]{1,100}$/u.test(provider) ? provider : 'provider';
  return { nextAttemptAt: settings.nextAttemptAt, providerLabel };
}
