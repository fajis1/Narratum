import { isScholarLikeSmartAudioMode } from '@/lib/shared/smart-audio-cleanup';
import { MULTI_VOICE_WORKER_MODE } from '@/lib/shared/multi-voice';

const STANDARD_SMART_AUDIO_NATS_TIMEOUT_MS = 120_000;
const SCHOLAR_SMART_AUDIO_NATS_TIMEOUT_MS = 600_000;
const MIN_SMART_AUDIO_NATS_TIMEOUT_MS = 30_000;
const MAX_SMART_AUDIO_NATS_TIMEOUT_MS = 900_000;

export function resolveSmartAudioNatsTimeoutMs(
  workerMode: string | null | undefined,
  configuredValue: string | undefined = process.env.SMART_AUDIO_NATS_TIMEOUT_MS,
): number {
  const fallback = isScholarLikeSmartAudioMode(workerMode) || workerMode === MULTI_VOICE_WORKER_MODE
    ? SCHOLAR_SMART_AUDIO_NATS_TIMEOUT_MS
    : STANDARD_SMART_AUDIO_NATS_TIMEOUT_MS;
  if (!configuredValue?.trim()) return fallback;

  const parsed = Number(configuredValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(
    MAX_SMART_AUDIO_NATS_TIMEOUT_MS,
    Math.max(MIN_SMART_AUDIO_NATS_TIMEOUT_MS, Math.round(parsed)),
  );
}
