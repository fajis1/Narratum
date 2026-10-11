'use client';

import { useEffect, useState } from 'react';
import { formatGeminiCooldownDuration } from '@/lib/shared/audiobook-gemini-cooldown';
import type { AudiobookProviderRetrySchedule } from '@/lib/shared/audiobook-provider-retry';

export function AudiobookProviderRetryNotice({ retry }: { retry: AudiobookProviderRetrySchedule }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const retryTime = new Date(retry.nextAttemptAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return (
    <div className="max-w-2xl rounded border border-warning/30 bg-warning/10 p-3 text-warning">
      <p className="font-semibold">Automatic {retry.providerLabel} retry</p>
      <p className="mt-1 text-xs font-semibold" role="timer">
        {now < retry.nextAttemptAt
          ? `Automatic retry at ${retryTime} — ${formatGeminiCooldownDuration(retry.nextAttemptAt - now)} remaining.`
          : 'Retry time has arrived. Waiting for the queue to resume processing.'}
      </p>
      <p className="mt-1 text-xs leading-relaxed">Completed chapters and progress are preserved. Generation will resume automatically when the retry can start.</p>
    </div>
  );
}
