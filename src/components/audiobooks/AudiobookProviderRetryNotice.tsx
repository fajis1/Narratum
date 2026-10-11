'use client';

import { useEffect, useState } from 'react';
import { formatGeminiCooldownDuration } from '@/lib/shared/audiobook-gemini-cooldown';
import type { AudiobookProviderRetrySchedule } from '@/lib/shared/audiobook-provider-retry';
import { Button } from '@/components/ui';

export function AudiobookProviderRetryNotice({ retry, jobId, onRetryRequested }: {
  retry: AudiobookProviderRetrySchedule;
  jobId?: string;
  onRetryRequested?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [attempt, setAttempt] = useState<{
    jobId: string;
    nextAttemptAt: number;
    state: 'requesting' | 'requested' | 'failed';
    error?: string;
  } | null>(null);
  // A fresh provider failure gets a new schedule and can be retried again.
  const currentAttempt = attempt?.jobId === jobId && attempt?.nextAttemptAt === retry.nextAttemptAt ? attempt : null;
  const retryNow = async () => {
    if (!jobId || currentAttempt?.state === 'requesting' || currentAttempt?.state === 'requested') return;
    const identity = { jobId, nextAttemptAt: retry.nextAttemptAt };
    setAttempt({ ...identity, state: 'requesting' });
    try {
      const response = await fetch('/api/audiobooks/queue', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not request a Gemini retry.');
      }
    } catch (error) {
      setAttempt({ ...identity, state: 'failed', error: error instanceof Error ? error.message : 'Could not request a Gemini retry.' });
      return;
    }
    setAttempt({ ...identity, state: 'requested' });
    onRetryRequested?.();
  };
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const retryTime = new Date(retry.nextAttemptAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return (
    <div className="max-w-2xl rounded border border-warning/30 bg-warning/10 p-3 text-warning">
      <p className="font-semibold">Automatic {retry.providerLabel} retry</p>
      <p className="mt-1 text-xs font-semibold" role="timer">
        {currentAttempt?.state === 'requested'
          ? 'Retry requested. Waiting for the queue to resume processing.'
          : now < retry.nextAttemptAt
          ? `Automatic retry at ${retryTime} — ${formatGeminiCooldownDuration(retry.nextAttemptAt - now)} remaining.`
          : 'Retry time has arrived. Waiting for the queue to resume processing.'}
      </p>
      <p className="mt-1 text-xs leading-relaxed">Completed chapters and progress are preserved. Generation will resume automatically when the retry can start.</p>
      {jobId && retry.providerLabel === 'Gemini' && currentAttempt?.state !== 'requested' && (
        <div className="mt-2">
          <Button type="button" size="sm" disabled={currentAttempt?.state === 'requesting'} onClick={retryNow}>
            {currentAttempt?.state === 'requesting' ? 'Requesting retry…' : 'Retry Gemini now'}
          </Button>
          <p className="mt-1 text-xs leading-relaxed">Try again without waiting for this countdown. Gemini may ask you to wait again.</p>
        </div>
      )}
      {currentAttempt?.error && <p role="alert" className="mt-1 text-xs text-danger">{currentAttempt.error}</p>}
    </div>
  );
}
