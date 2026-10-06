export const GEMINI_RATE_LIMIT_PAUSE_MESSAGE =
  'Gemini API limits paused this audiobook. Completed chapters are preserved, and OpenReader will retry automatically when API capacity becomes available.';

export const GEMINI_CLEANUP_TIMEOUT_PAUSE_MESSAGE =
  'Gemini cleanup response timed out. Completed chapters are preserved, and OpenReader will retry automatically after a five-minute cooldown.';

export const GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE =
  'Google Cloud TTS daily quota or credits exhausted. Completed chapters are preserved, and OpenReader will automatically resume after the daily refresh cycle.';

export const GOOGLE_CLOUD_TTS_RATE_LIMIT_PAUSE_MESSAGE =
  'Google Cloud TTS rate limits paused this audiobook. Completed chapters are preserved, and OpenReader will retry automatically after a cooldown.';

export const SYSTEM_RESOURCES_PAUSE_PREFIX = 'Queue paused (system resources):';

export function isSystemResourcePause(error: string | null | undefined): boolean {
  if (!error) return false;
  return error.startsWith(SYSTEM_RESOURCES_PAUSE_PREFIX)
    || error.startsWith('System resources degraded')
    || error.startsWith('Queue paused (system resources)');
}

export function formatSystemResourcePauseMessage(reason: string): string {
  const cleanReason = reason.replace(/^System resources degraded:\s*/i, '').trim();
  return `${SYSTEM_RESOURCES_PAUSE_PREFIX} ${cleanReason}. Completed chapters are preserved, and OpenReader will automatically resume generation when resources recover.`;
}

export const AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS = 'pausing';

export function isGeminiRateLimitPause(error: string | null | undefined): boolean {
  if (!error) return false;
  return error === GEMINI_RATE_LIMIT_PAUSE_MESSAGE
    || error === GEMINI_CLEANUP_TIMEOUT_PAUSE_MESSAGE
    || error === GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE
    || error === GOOGLE_CLOUD_TTS_RATE_LIMIT_PAUSE_MESSAGE
    || error.startsWith('Google Cloud TTS')
    || error.startsWith('Gemini API limits paused');
}

export function isAudiobookQueueHaltedOrPaused(error: string | null | undefined): boolean {
  return isGeminiRateLimitPause(error) || isSystemResourcePause(error);
}

export interface JobDescriptiveState {
  reason: string;
  category: 'running' | 'queued' | 'paused' | 'waiting' | 'error' | 'completed';
  isPaused: boolean;
  isDegraded: boolean;
  badgeText: string;
  badgeVariant: 'accent' | 'warning' | 'danger' | 'success' | 'soft';
}

export function resolveAudiobookJobDescriptiveState(
  job: {
    id?: string;
    status: string;
    progress?: number | null;
    error?: string | null;
    phase?: string | null;
    globalQueuePosition?: number | null;
  },
  context?: {
    queueDegraded?: boolean;
    queueDegradedReason?: string;
    activeJobsCount?: number;
    maxConcurrentJobs?: number;
  }
): JobDescriptiveState {
  const isPauseRequested = job.status === AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS;
  const isWaitingForGpu = job.phase === 'waiting_for_gpu';
  const isWaitingForVoices = job.status === 'waiting_for_voices' || job.error === 'waiting_for_voices';
  const isWaitingForPdf = job.status === 'waiting_for_pdf';

  if (job.status === 'completed') {
    return {
      reason: 'Audiobook generation complete.',
      category: 'completed',
      isPaused: false,
      isDegraded: false,
      badgeText: 'Completed',
      badgeVariant: 'success',
    };
  }

  if (job.status === 'error') {
    return {
      reason: `Generation stopped: ${job.error || 'Unknown error occurred'}`,
      category: 'error',
      isPaused: false,
      isDegraded: false,
      badgeText: 'Error',
      badgeVariant: 'danger',
    };
  }

  if (job.status === 'running' || isPauseRequested) {
    if (isWaitingForGpu) {
      return {
        reason: 'Waiting for the shared Kokoro GPU. Generation will continue automatically when the GPU is ready.',
        category: 'waiting',
        isPaused: false,
        isDegraded: false,
        badgeText: 'Waiting for GPU',
        badgeVariant: 'warning',
      };
    }
    if (isPauseRequested) {
      return {
        reason: 'Pause requested. The worker will finish the current chapter step before stopping.',
        category: 'paused',
        isPaused: true,
        isDegraded: false,
        badgeText: 'Pausing',
        badgeVariant: 'warning',
      };
    }
    return {
      reason: `Generating audiobook (${Math.round(job.progress || 0)}% complete). In active worker slot.`,
      category: 'running',
      isPaused: false,
      isDegraded: false,
      badgeText: 'Running',
      badgeVariant: 'accent',
    };
  }

  if (isWaitingForPdf) {
    return {
      reason: 'Extracting and parsing document text. Generation will begin once chapters are formatted.',
      category: 'waiting',
      isPaused: false,
      isDegraded: false,
      badgeText: 'Parsing Text',
      badgeVariant: 'warning',
    };
  }

  if (isWaitingForVoices) {
    return {
      reason: 'Character voice casting review required before generation can proceed. Click "Review Character Voices" to assign voices.',
      category: 'waiting',
      isPaused: true,
      isDegraded: false,
      badgeText: 'Voice Review',
      badgeVariant: 'warning',
    };
  }

  if (isSystemResourcePause(job.error)) {
    return {
      reason: job.error!,
      category: 'paused',
      isPaused: true,
      isDegraded: true,
      badgeText: 'Paused (Low Resources)',
      badgeVariant: 'warning',
    };
  }

  if (context?.queueDegraded && (job.status === 'queued' || job.status === 'waiting_for_pdf')) {
    const pauseMsg = formatSystemResourcePauseMessage(context.queueDegradedReason || 'Low system resources');
    return {
      reason: pauseMsg,
      category: 'paused',
      isPaused: true,
      isDegraded: true,
      badgeText: 'Paused (Low Resources)',
      badgeVariant: 'warning',
    };
  }

  if (isGeminiRateLimitPause(job.error)) {
    return {
      reason: job.error!,
      category: 'paused',
      isPaused: true,
      isDegraded: false,
      badgeText: 'Paused (Rate Limit)',
      badgeVariant: 'warning',
    };
  }

  if (job.status === 'paused') {
    return {
      reason: job.error || 'Audiobook generation is paused by user.',
      category: 'paused',
      isPaused: true,
      isDegraded: false,
      badgeText: 'Paused',
      badgeVariant: 'warning',
    };
  }

  if (job.status === 'queued') {
    const pos = job.globalQueuePosition || 1;
    const activeCount = context?.activeJobsCount ?? 0;
    const maxJobs = context?.maxConcurrentJobs ?? 3;

    if (activeCount >= maxJobs) {
      return {
        reason: `In queue: Position #${pos}. All ${maxJobs} worker slots are busy. Generation will start automatically when a slot opens.`,
        category: 'queued',
        isPaused: false,
        isDegraded: false,
        badgeText: `Queued (#${pos})`,
        badgeVariant: 'soft',
      };
    }

    if (activeCount > 0) {
      return {
        reason: `In queue: Position #${pos}. ${activeCount} audiobook(s) currently generating.`,
        category: 'queued',
        isPaused: false,
        isDegraded: false,
        badgeText: `Queued (#${pos})`,
        badgeVariant: 'soft',
      };
    }

    return {
      reason: `In queue: Position #${pos}. Ready to be picked up by the background runner.`,
      category: 'queued',
      isPaused: false,
      isDegraded: false,
      badgeText: `Queued (#${pos})`,
      badgeVariant: 'soft',
    };
  }

  return {
    reason: `Job status: ${job.status}`,
    category: 'queued',
    isPaused: false,
    isDegraded: false,
    badgeText: job.status,
    badgeVariant: 'soft',
  };
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
