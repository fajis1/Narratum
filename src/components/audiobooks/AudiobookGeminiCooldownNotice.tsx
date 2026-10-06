'use client';

import { useEffect, useState } from 'react';
import { formatGeminiCooldownDuration, geminiCooldownExplanation, type AudiobookGeminiCooldown } from '@/lib/shared/audiobook-gemini-cooldown';

export function AudiobookGeminiCooldownNotice({ cooldown }: { cooldown: AudiobookGeminiCooldown }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const retryTime = new Date(cooldown.retryAt).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return (
    <div className="max-w-2xl rounded border border-warning/30 bg-warning/10 p-3 text-warning">
      <p className="font-semibold">Waiting for Gemini {cooldown.reason === 'rate_limit' ? 'quota / rate limit' : 'recovery'}</p>
      <p className="mt-1 text-xs leading-relaxed">{geminiCooldownExplanation(cooldown)}</p>
      <p className="mt-1 text-xs font-semibold">
        {now < cooldown.retryAt
          ? `Automatic retry at ${retryTime} — ${formatGeminiCooldownDuration(cooldown.retryAt - now)} remaining.`
          : 'The cooldown has ended. Retrying automatically; waiting for the next provider response.'}
      </p>
      {cooldown.reason === 'rate_limit' && (
        <p className="mt-1 text-xs leading-relaxed">
          You can wait for automatic retry. Check your API key quota or choose a model with available quota in Smart Audio Settings for a new job attempt. Changing settings alone does not change the worker&apos;s current wait.
        </p>
      )}
    </div>
  );
}
