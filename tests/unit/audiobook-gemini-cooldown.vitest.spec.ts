import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetchGeminiWithRateLimitFallback } from '@/lib/server/smart-audio/gemini-failover';
import { withGeminiRecoveryContext, setGeminiRecoveryChapter } from '@/lib/server/smart-audio/gemini-recovery-context';
import { readAudiobookGeminiCooldown, writeAudiobookGeminiCooldown, geminiCooldownExplanation,
  formatGeminiCooldownDuration, type AudiobookGeminiCooldown } from '@/lib/shared/audiobook-gemini-cooldown';
import { resolveAudiobookJobDescriptiveState } from '@/lib/shared/audiobook-job-status';

describe('visible Gemini cooldowns', () => {
  test('publishes the full 5h15m14s server delay before a retry and clears it without losing progress/settings', async () => {
    const updates: Array<AudiobookGeminiCooldown | null> = [];
    let saved: Record<string, unknown> = { progress: 50, voice: 'af_heart', runtimePhase: 'waiting_for_gpu' };
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '18914' } }))
      .mockImplementationOnce(async () => {
        expect(saved.geminiCooldown).toBeUndefined();
        return new Response('ok');
      });
    await withGeminiRecoveryContext(async (state) => {
      updates.push(state);
      saved = writeAudiobookGeminiCooldown(saved, state);
      if (state) expect(readAudiobookGeminiCooldown(saved, 'running')).toEqual(state);
    }, async () => {
      setGeminiRecoveryChapter(22);
      await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'private-fixture', requestedModel: 'gemini-3.8-flash',
        fallbackModels: [], maxAttempts: 2, retryRateLimitedModels: true, request });
    });
    expect(updates).toHaveLength(2);
    const state = updates[0]!;
    expect(state).toMatchObject({ reason: 'rate_limit', httpStatus: 429, model: 'gemini-3.8-flash', chapterIndex: 22, serverDirected: true });
    expect(state.retryAt - state.startedAt).toBe(18_914_000);
    expect(formatGeminiCooldownDuration(state.retryAt - state.startedAt)).toBe('5h 15m 14s');
    expect(geminiCooldownExplanation(state)).toContain('Completed chapters and progress are preserved');
    expect(geminiCooldownExplanation(state)).toContain('chapter 23');
    expect(JSON.stringify(updates)).not.toContain('private-fixture');
    expect(updates[1]).toBeNull();
    expect(saved).toEqual({ progress: 50, voice: 'af_heart', runtimePhase: 'waiting_for_gpu' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  test('keeps concurrent job recovery states isolated', async () => {
    const states: Array<Array<AudiobookGeminiCooldown | null>> = [[], []];
    await Promise.all(states.map((target, index) => withGeminiRecoveryContext(async state => { target.push(state); }, async () => {
      setGeminiRecoveryChapter(index);
      const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response('ok'));
      await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: `model-${index}`, fallbackModels: [],
        retryRateLimitedModels: true, maxAttempts: 2, request });
    })));
    for (const [index, events] of states.entries()) {
      expect(events[0]).toMatchObject({ chapterIndex: index, model: `model-${index}`, reason: 'unavailable', serverDirected: false });
      expect(events[1]).toBeNull();
    }
  });
  test('a failed status write does not interrupt retry/fallback', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(new Response('ok'));
    const result = await withGeminiRecoveryContext(async () => { throw new Error('database unavailable'); },
      () => fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: 'model', fallbackModels: [],
        maxAttempts: 2, retryRateLimitedModels: true, request }));
    expect(result.response.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
  test('clears the visible cooldown on abort without issuing another provider request', async () => {
    const controller = new AbortController();
    const events: Array<AudiobookGeminiCooldown | null> = [];
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '18914' } }));
    await expect(withGeminiRecoveryContext(async state => {
      events.push(state);
      if (state) controller.abort();
    }, () => fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: 'model', fallbackModels: [],
      retryRateLimitedModels: true, maxAttempts: 2, signal: controller.signal, request }))).rejects.toThrow();
    expect(events).toHaveLength(2);
    expect(events[0]?.httpStatus).toBe(429);
    expect(events[1]).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('also reports model and cause for the default overload retry path', async () => {
    const events: Array<AudiobookGeminiCooldown | null> = [];
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(new Response('ok'));
    await withGeminiRecoveryContext(async state => { events.push(state); },
      () => fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: 'model', fallbackModels: [], maxAttempts: 2, request }));
    expect(events[0]).toMatchObject({ model: 'model', httpStatus: 503, reason: 'unavailable' });
    expect(events[1]).toBeNull();
  });
  test('validates legacy/malformed runtime data and suppresses terminal/queued stale state', () => {
    const state = { reason: 'rate_limit' as const, startedAt: 1000, retryAt: 18_915_000, serverDirected: true };
    expect(readAudiobookGeminiCooldown(undefined, 'running')).toBeNull();
    expect(readAudiobookGeminiCooldown('bad json', 'running')).toBeNull();
    expect(readAudiobookGeminiCooldown({ geminiCooldown: { ...state, retryAt: -1 } }, 'running')).toBeNull();
    expect(readAudiobookGeminiCooldown({ geminiCooldown: { ...state, reason: 'bogus' } }, 'running')).toBeNull();
    for (const status of ['completed', 'queued', 'paused', 'error']) {
      expect(readAudiobookGeminiCooldown({ geminiCooldown: state }, status)).toBeNull();
    }
    expect(readAudiobookGeminiCooldown(JSON.stringify({ geminiCooldown: state }), 'running')).toEqual(state);
    expect(readAudiobookGeminiCooldown({ geminiCooldown: { ...state, model: 'https://private?key=fixture' } }, 'running')).toEqual(state);
    const descriptive = resolveAudiobookJobDescriptiveState({ status: 'running', progress: 50, error: null, settingsJson: { geminiCooldown: state } });
    expect(descriptive).toMatchObject({ category: 'waiting', badgeText: 'Waiting for Gemini', isPaused: false });
    expect(descriptive.reason).toContain('Google requested a 5h 15m 14s cooldown');
    expect(formatGeminiCooldownDuration(-1000)).toBe('0s');
  });
  test('shows the notice in both queue and audiobook progress, suppressing misleading completion ETAs', () => {
    for (const path of ['src/components/doclist/views/JobsInlineView.tsx', 'src/components/AudiobookExportModal.tsx']) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(source).toContain('readAudiobookGeminiCooldown');
      expect(source).toContain('AudiobookGeminiCooldownNotice');
    }
    const queue = readFileSync(resolve(process.cwd(), 'src/components/doclist/views/JobsInlineView.tsx'), 'utf8');
    expect(queue).toContain('!geminiCooldown && !isWaitingForGpu');
    const notice = readFileSync(resolve(process.cwd(), 'src/components/audiobooks/AudiobookGeminiCooldownNotice.tsx'), 'utf8');
    expect(notice).toContain('Automatic retry at');
    expect(notice).toContain('The cooldown has ended. Retrying automatically');
    expect(notice).toContain('Changing settings alone does not change');
    expect(notice).not.toContain('midnight');
  });
});
