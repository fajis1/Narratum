import { describe, expect, test, vi } from 'vitest';
import {
  fetchGeminiWithRateLimitFallback,
  isGeminiModelUnavailableResponse,
} from '../../src/lib/server/smart-audio/gemini-failover';

describe('Gemini key failover', () => {
  test('opt-in quota retries pace key/model switches and cap the delay at five minutes', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 }));
    const onStatusUpdate = vi.fn();
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'primary-fixture', backupApiKey: 'backup-fixture',
      requestedModel: 'gemini-3.8-flash', maxAttempts: 3, retryRateLimitedModels: true, request, onStatusUpdate });
    expect(result.usedModel).toBe('gemini-3.6-flash');
    expect(request).toHaveBeenCalledTimes(12);
    expect(request.mock.calls).toEqual([
      ...Array(3).fill(['primary-fixture', 'gemini-3.8-flash']),
      ...Array(3).fill(['backup-fixture', 'gemini-3.8-flash']),
      ...Array(3).fill(['primary-fixture', 'gemini-3.7-flash']),
      ...Array(3).fill(['primary-fixture', 'gemini-3.6-flash']),
    ]);
    expect(onStatusUpdate.mock.calls.map(([message]) => message).filter(message => message.startsWith('Gemini recovery cooldown:')))
      .toEqual([4, 8, 16, 32, 64, 128, 256, 300, 300, 300, 300].map(seconds => `Gemini recovery cooldown: waiting ${seconds}s before the next request.`));
  });

  test('opt-in fallback honors server cooldowns and retains backup-only credentials', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '380' } }))
      .mockResolvedValueOnce(new Response('ok'));
    const onStatusUpdate = vi.fn();
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: '', backupApiKey: 'backup-fixture',
      requestedModel: 'first', fallbackModels: ['second'], maxAttempts: 1, retryRateLimitedModels: true, request, onStatusUpdate });
    expect(result).toMatchObject({ usedModel: 'second', usedBackup: true });
    expect(request.mock.calls).toEqual([['backup-fixture', 'first'], ['backup-fixture', 'second']]);
    expect(onStatusUpdate).toHaveBeenCalledWith('Gemini recovery cooldown: waiting 380s before the next request.');
  });

  test('cancellation stops opt-in recovery before a fallback request', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => new Response(null, { status: 429 }));
    await expect(fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: 'first', fallbackModels: ['second'],
      maxAttempts: 1, retryRateLimitedModels: true, signal: controller.signal, request,
      onStatusUpdate: message => { if (message.startsWith('Gemini recovery cooldown:')) controller.abort(); },
    })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('honors explicit fallback order and an empty list disables model fallback', async () => {
    const request = vi.fn(async (_key: string, model?: string) => new Response(null, { status: model === 'chosen-two' ? 200 : 503 }));
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: 'gemini-3.8-flash', fallbackModels: ['chosen-one', 'chosen-two'], maxAttempts: 1, request });
    expect(result.usedModel).toBe('chosen-two');
    expect(request.mock.calls.map(call => call[1])).toEqual(['gemini-3.8-flash', 'chosen-one', 'chosen-two']);
    request.mockClear();
    await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: 'gemini-3.8-flash', fallbackModels: [], maxAttempts: 1, request });
    expect(request).toHaveBeenCalledTimes(1);
  });
  test('primary overload still uses a fallback model when the backup is rate limited', async () => {
    const request = vi.fn(async (key: string, model?: string) => {
      if (key === 'backup-fixture') return new Response(null, { status: 429 });
      return new Response(null, { status: model === 'gemini-3.6-flash' ? 200 : 503 });
    });
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'primary-fixture', backupApiKey: 'backup-fixture',
      requestedModel: 'gemini-3.8-flash', maxAttempts: 3, initialDelayMs: 0, request });
    expect(result).toMatchObject({ usedModel: 'gemini-3.6-flash', usedBackup: false, usedModelFallback: true });
    expect(request.mock.calls.filter(([key]) => key === 'backup-fixture')).toHaveLength(3);
    expect(request.mock.calls.filter(([, model]) => model === 'gemini-3.7-flash')).toHaveLength(3);
    expect(request.mock.calls.at(-1)).toEqual(['primary-fixture', 'gemini-3.6-flash']);
  });

  test('pure rate limits do not trigger model hopping', async () => {
    const request = vi.fn(async () => new Response(null, { status: 429 }));
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'primary-fixture', backupApiKey: 'backup-fixture',
      requestedModel: 'gemini-3.8-flash', maxAttempts: 1, request });
    expect(result.usedModelFallback).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });
  test('uses backup after bounded network retries but does not fail over cancellation', async () => {
    const request = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockRejectedValueOnce(new TypeError('network')).mockResolvedValue(new Response('ok'));
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'primary-fixture', backupApiKey: 'backup-fixture', maxAttempts: 2, request });
    expect(result.usedBackup).toBe(true);
    expect(request).toHaveBeenNthCalledWith(3, 'backup-fixture');
    request.mockReset().mockRejectedValue(new DOMException('cancel', 'AbortError'));
    await expect(fetchGeminiWithRateLimitFallback({ primaryApiKey: 'primary-fixture', backupApiKey: 'backup-fixture', maxAttempts: 2, request })).rejects.toThrow('cancel');
    expect(request).toHaveBeenCalledTimes(1);
  });
  test.each([429, 500, 502, 503, 504])('uses a distinct backup after HTTP %s', async (status) => {
    const request = vi.fn();
    // Primary key fails 8 attempts with status, 9th attempt (backup key) succeeds with 200
    for (let i = 0; i < 8; i += 1) {
      request.mockResolvedValueOnce(new Response(null, { status }));
    }
    request.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const result = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'primary-placeholder',
      backupApiKey: 'backup-placeholder',
      request,
      initialDelayMs: 0,
    });

    expect(result.response.status).toBe(200);
    expect(result.usedBackup).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, 'primary-placeholder');
    expect(request).toHaveBeenNthCalledWith(9, 'backup-placeholder');
  });

  test('does not retry non-transient errors or duplicate credentials', async () => {
    const ordinaryError = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    expect((await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'same-placeholder',
      backupApiKey: 'backup-placeholder',
      request: ordinaryError,
      initialDelayMs: 0,
    })).usedBackup).toBe(false);
    expect(ordinaryError).toHaveBeenCalledTimes(1);

    const duplicateKey = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    expect((await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'same-placeholder',
      backupApiKey: 'same-placeholder',
      request: duplicateKey,
      initialDelayMs: 0,
    })).usedBackup).toBe(false);
    expect(duplicateKey).toHaveBeenCalledTimes(8);
  });

  test('falls back through the explicit model chain on a definitive unavailable-model error', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'models/gemini-3.7-flash is not found for API version v1beta, or is not supported for generateContent' },
      }), { status: 404 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const onStatusUpdate = vi.fn();

    const result = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'primary-placeholder',
      requestedModel: 'gemini-3.7-flash',
      request,
      onStatusUpdate,
      initialDelayMs: 0,
    });

    expect(result.response.status).toBe(200);
    expect(result.requestedModel).toBe('gemini-3.7-flash');
    expect(result.usedModel).toBe('gemini-3.6-flash');
    expect(result.usedModelFallback).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, 'primary-placeholder', 'gemini-3.7-flash');
    expect(request).toHaveBeenNthCalledWith(2, 'primary-placeholder', 'gemini-3.6-flash');
    expect(onStatusUpdate).toHaveBeenCalledWith(
      'gemini-3.7-flash is unavailable for this Gemini API project. Using gemini-3.6-flash for this request.',
    );
  });

  test('falls back to the next model after sustained HTTP 503 overload (fast failover within 2 attempts per key)', async () => {
    const request = vi.fn();
    // 2 attempts on primary key, 2 attempts on backup key, then 5th call on fallback model succeeds
    for (let i = 0; i < 4; i += 1) {
      request.mockResolvedValueOnce(new Response('model is overloaded', { status: 503 }));
    }
    request.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const onStatusUpdate = vi.fn();

    const result = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'primary-placeholder',
      backupApiKey: 'backup-placeholder',
      requestedModel: 'gemini-3.7-flash',
      request,
      onStatusUpdate,
      initialDelayMs: 0,
    });

    expect(result.response.status).toBe(200);
    expect(result.usedBackup).toBe(false);
    expect(result.requestedModel).toBe('gemini-3.7-flash');
    expect(result.usedModel).toBe('gemini-3.6-flash');
    expect(result.usedModelFallback).toBe(true);
    expect(request).toHaveBeenNthCalledWith(1, 'primary-placeholder', 'gemini-3.7-flash');
    expect(request).toHaveBeenNthCalledWith(2, 'primary-placeholder', 'gemini-3.7-flash');
    expect(request).toHaveBeenNthCalledWith(3, 'backup-placeholder', 'gemini-3.7-flash');
    expect(request).toHaveBeenNthCalledWith(4, 'backup-placeholder', 'gemini-3.7-flash');
    expect(request).toHaveBeenNthCalledWith(5, 'primary-placeholder', 'gemini-3.6-flash');
    expect(onStatusUpdate).toHaveBeenCalledWith(
      'gemini-3.7-flash remained overloaded after retries. Using gemini-3.6-flash for this request.',
    );
  });

  test('fast-fails over within 2 attempts on HTTP 503 when hasAlternativeProvider is enabled', async () => {
    const request = vi.fn().mockResolvedValue(new Response('service overloaded', { status: 503 }));
    const onStatusUpdate = vi.fn();

    const result = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'primary-placeholder',
      requestedModel: 'custom-single-model',
      fallbackModels: [],
      hasAlternativeProvider: true,
      request,
      onStatusUpdate,
      initialDelayMs: 0,
    });

    expect(result.response.status).toBe(503);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, 'primary-placeholder', 'custom-single-model');
    expect(request).toHaveBeenNthCalledWith(2, 'primary-placeholder', 'custom-single-model');
  });

  test('honors explicit maxOverloadAttempts override on HTTP 503', async () => {
    const request = vi.fn().mockResolvedValue(new Response('service overloaded', { status: 503 }));

    const result = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'primary-placeholder',
      requestedModel: 'custom-single-model',
      fallbackModels: [],
      maxOverloadAttempts: 1,
      request,
      initialDelayMs: 0,
    });

    expect(result.response.status).toBe(503);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('does not change models after HTTP 429 quota exhaustion', async () => {
    const request = vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 429 }));

    const result = await fetchGeminiWithRateLimitFallback({
      primaryApiKey: 'primary-placeholder',
      requestedModel: 'gemini-3.7-flash',
      request,
      initialDelayMs: 0,
    });

    expect(result.response.status).toBe(429);
    expect(result.usedModel).toBe('gemini-3.7-flash');
    expect(result.usedModelFallback).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('primary-placeholder', 'gemini-3.7-flash');
  });

  test('never retries an aborted request or switches to a backup after cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); throw new DOMException('Stopped', 'AbortError'); });
    await expect(fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', backupApiKey: 'backup', requestedModel: 'gemini-3.8-flash', signal: controller.signal, request })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('does not start a request with an already expired signal', async () => {
    const request = vi.fn();
    await expect(fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', signal: AbortSignal.abort(), request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  test('stops before backoff when cancelled by the retry observer', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue(new Response('Busy', { status: 503 }));
    await expect(fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', request, signal: controller.signal, onStatusUpdate: () => controller.abort() })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('honors a shorter repair retry budget before trying the backup key', async () => {
    const request = vi.fn().mockImplementation(async (key: string) => key === 'primary-fixture' ? new Response('Busy', { status: 503 }) : Response.json({ ok: true }));
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'primary-fixture', backupApiKey: 'backup-fixture', maxAttempts: 3, request });
    expect(result.usedBackup).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  test('uses a configured backup directly when the primary is blank', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: '', backupApiKey: 'backup-fixture', request });
    expect(request).toHaveBeenCalledWith('backup-fixture');
    expect(result.usedBackup).toBe(true);
  });

  test('falls back from unavailable 3.8 to 3.7', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('model not found', { status: 404 })).mockResolvedValueOnce(Response.json({ ok: true }));
    const result = await fetchGeminiWithRateLimitFallback({ primaryApiKey: 'fixture', requestedModel: 'gemini-3.8-flash', request });
    expect(result.usedModel).toBe('gemini-3.7-flash');
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('classifies only definitive unavailable-model responses as unavailable', async () => {
    for (const response of [
      new Response('forbidden', { status: 403 }),
      new Response('quota exceeded', { status: 429 }),
      new Response('temporarily unavailable', { status: 503 }),
      new Response('invalid generation config', { status: 400 }),
    ]) {
      expect(await isGeminiModelUnavailableResponse(response)).toBe(false);
    }
  });
});
