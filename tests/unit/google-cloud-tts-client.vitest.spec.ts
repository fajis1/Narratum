/**
 * Stage 3 — Cloud Gemini-TTS Client Spike
 *
 * Tests for google-cloud-tts-client.ts covering:
 *  1. Byte measurement utilities
 *  2. Tag allowlist and stripping
 *  3. Token cache — happy path, coalescing, eviction
 *  4. synthesizeWithCloudTts — input validation, happy path, 401 eviction, API errors
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  measureUtf8Bytes,
  fitsWithinByteLimit,
  stripDisallowedTags,
  GoogleCloudTokenCache,
  synthesizeWithCloudTts,
  CloudTtsInputError,
  CloudTtsApiError,
  CLOUD_TTS_SAFE_TEXT_BYTES,
  CLOUD_TTS_SAFE_PROMPT_BYTES,
  DRAMA_ONE_SHOT_TAGS,
  DRAMA_STYLE_TAGS,
  DRAMA_PAUSE_TAGS,
  DRAMA_ALLOWED_TAG_SET,
  CLOUD_TTS_MODEL,
} from '../../src/lib/server/smart-audio/google-cloud-tts-client';

import { GoogleCloudAuthError } from '../../src/lib/server/smart-audio/google-cloud-auth';

// ── 1. Byte measurement ────────────────────────────────────────────────────────

describe('Stage 3 — measureUtf8Bytes', () => {
  it('returns ASCII byte count for ASCII strings', () => {
    expect(measureUtf8Bytes('hello')).toBe(5);
    expect(measureUtf8Bytes('')).toBe(0);
  });

  it('counts multi-byte characters correctly', () => {
    // '£' is 2 bytes in UTF-8
    expect(measureUtf8Bytes('£')).toBe(2);
    // '€' is 3 bytes
    expect(measureUtf8Bytes('€')).toBe(3);
    // '𝄞' (musical symbol G clef) is 4 bytes
    expect(measureUtf8Bytes('𝄞')).toBe(4);
  });

  it('JavaScript charCodeAt vs byte length differ for multi-byte', () => {
    const s = '€€€';
    expect(s.length).toBe(3);         // 3 JS chars
    expect(measureUtf8Bytes(s)).toBe(9); // 9 UTF-8 bytes
  });
});

describe('Stage 3 — fitsWithinByteLimit', () => {
  it('returns true when bytes <= limit', () => {
    expect(fitsWithinByteLimit('hello', 5)).toBe(true);
    expect(fitsWithinByteLimit('hello', 100)).toBe(true);
  });

  it('returns false when bytes > limit', () => {
    expect(fitsWithinByteLimit('hello', 4)).toBe(false);
  });

  it('works correctly for multi-byte content', () => {
    const sixBytes = '€€'; // 6 bytes
    expect(fitsWithinByteLimit(sixBytes, 6)).toBe(true);
    expect(fitsWithinByteLimit(sixBytes, 5)).toBe(false);
  });
});

// ── 2. Audio-tag constants and stripping ───────────────────────────────────────

describe('Stage 3 — audio tag constants', () => {
  it('DRAMA_ONE_SHOT_TAGS contains expected tags', () => {
    expect(DRAMA_ONE_SHOT_TAGS).toContain('sigh');
    expect(DRAMA_ONE_SHOT_TAGS).toContain('laughing');
    expect(DRAMA_ONE_SHOT_TAGS).toContain('uhm');
  });

  it('DRAMA_STYLE_TAGS contains expected tags', () => {
    expect(DRAMA_STYLE_TAGS).toContain('whispering');
    expect(DRAMA_STYLE_TAGS).toContain('shouting');
    expect(DRAMA_STYLE_TAGS).toContain('sarcasm');
    expect(DRAMA_STYLE_TAGS).toContain('robotic');
    expect(DRAMA_STYLE_TAGS).toContain('extremely fast');
  });

  it('DRAMA_PAUSE_TAGS contains expected tags', () => {
    expect(DRAMA_PAUSE_TAGS).toContain('short pause');
    expect(DRAMA_PAUSE_TAGS).toContain('medium pause');
    expect(DRAMA_PAUSE_TAGS).toContain('long pause');
  });

  it('DRAMA_ALLOWED_TAG_SET contains all tags from all three lists', () => {
    for (const tag of [...DRAMA_ONE_SHOT_TAGS, ...DRAMA_STYLE_TAGS, ...DRAMA_PAUSE_TAGS]) {
      expect(DRAMA_ALLOWED_TAG_SET.has(tag)).toBe(true);
    }
  });

  it('emotional adjective tags are NOT in the allowlist', () => {
    // Google warns these may be vocalized — intentionally excluded
    expect(DRAMA_ALLOWED_TAG_SET.has('scared')).toBe(false);
    expect(DRAMA_ALLOWED_TAG_SET.has('angry')).toBe(false);
    expect(DRAMA_ALLOWED_TAG_SET.has('curious')).toBe(false);
    expect(DRAMA_ALLOWED_TAG_SET.has('bored')).toBe(false);
  });
});

describe('Stage 3 — stripDisallowedTags', () => {
  it('passes through text with no tags unchanged', () => {
    const { sanitized, stripped } = stripDisallowedTags('He ran into the night.');
    expect(sanitized).toBe('He ran into the night.');
    expect(stripped).toHaveLength(0);
  });

  it('passes through allowed one-shot tags', () => {
    const { sanitized, stripped } = stripDisallowedTags('[sigh] I cannot believe it.');
    expect(sanitized).toBe('[sigh] I cannot believe it.');
    expect(stripped).toHaveLength(0);
  });

  it('passes through allowed style tags', () => {
    const { sanitized, stripped } = stripDisallowedTags(
      '[whispering] Careful now. [whispering]',
    );
    expect(sanitized).toBe('[whispering] Careful now. [whispering]');
    expect(stripped).toHaveLength(0);
  });

  it('passes through allowed pause tags', () => {
    const { sanitized, stripped } = stripDisallowedTags('Wait. [short pause] Then go.');
    expect(sanitized).toBe('Wait. [short pause] Then go.');
    expect(stripped).toHaveLength(0);
  });

  it('strips disallowed emotional adjective tags', () => {
    const { sanitized, stripped } = stripDisallowedTags('[scared] What was that?');
    expect(sanitized).toBe('What was that?');
    expect(stripped).toContain('[scared]');
  });

  it('strips multiple disallowed tags and preserves allowed ones', () => {
    const { sanitized, stripped } = stripDisallowedTags(
      '[angry] [sigh] I cannot do this anymore. [curious]',
    );
    expect(sanitized).toContain('[sigh]');
    expect(sanitized).not.toContain('[angry]');
    expect(sanitized).not.toContain('[curious]');
    expect(stripped).toContain('[angry]');
    expect(stripped).toContain('[curious]');
  });

  it('is case-insensitive for tag names', () => {
    const { sanitized, stripped } = stripDisallowedTags('[SCARED] Run!');
    expect(sanitized).toBe('Run!');
    expect(stripped).toContain('[SCARED]');
  });

  it('collapses extra whitespace left by stripped tags', () => {
    const { sanitized } = stripDisallowedTags('[angry]  Hello.');
    expect(sanitized).toBe('Hello.');
  });
});

// ── 3. GoogleCloudTokenCache ───────────────────────────────────────────────────

describe('Stage 3 — GoogleCloudTokenCache', () => {
  it('returns a fresh token from the fetcher on first call', async () => {
    const cache = new GoogleCloudTokenCache();
    const fetcher = vi.fn().mockResolvedValue({
      accessToken: 'tok-1',
      expiresAtMs: Date.now() + 3600 * 1000,
    });
    const result = await cache.getToken('key1', fetcher);
    expect(result).toBe('tok-1');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns cached token without calling fetcher again', async () => {
    const cache = new GoogleCloudTokenCache();
    const fetcher = vi.fn().mockResolvedValue({
      accessToken: 'tok-cached',
      expiresAtMs: Date.now() + 3600 * 1000,
    });
    await cache.getToken('key1', fetcher);
    const second = await cache.getToken('key1', fetcher);
    expect(second).toBe('tok-cached');
    expect(fetcher).toHaveBeenCalledTimes(1); // Only once
  });

  it('refreshes when cached token is within refresh margin', async () => {
    const cache = new GoogleCloudTokenCache();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'tok-old', expiresAtMs: Date.now() + 4 * 60 * 1000 }) // 4 min — within 5 min margin
      .mockResolvedValueOnce({ accessToken: 'tok-new', expiresAtMs: Date.now() + 3600 * 1000 });
    await cache.getToken('key1', fetcher);
    const result = await cache.getToken('key1', fetcher);
    expect(result).toBe('tok-new');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evict() forces a fresh fetch on next call', async () => {
    const cache = new GoogleCloudTokenCache();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'tok-a', expiresAtMs: Date.now() + 3600 * 1000 })
      .mockResolvedValueOnce({ accessToken: 'tok-b', expiresAtMs: Date.now() + 3600 * 1000 });
    await cache.getToken('key1', fetcher);
    cache.evict('key1');
    const result = await cache.getToken('key1', fetcher);
    expect(result).toBe('tok-b');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refresh requests into one fetch call', async () => {
    const cache = new GoogleCloudTokenCache();
    let resolveRefresh!: (v: { accessToken: string; expiresAtMs: number }) => void;
    const refreshPromise = new Promise<{ accessToken: string; expiresAtMs: number }>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetcher = vi.fn().mockReturnValue(refreshPromise);

    // Launch 3 concurrent gets before the fetcher resolves
    const [p1, p2, p3] = [
      cache.getToken('key1', fetcher),
      cache.getToken('key1', fetcher),
      cache.getToken('key1', fetcher),
    ];
    resolveRefresh({ accessToken: 'tok-coalesced', expiresAtMs: Date.now() + 3600 * 1000 });
    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(['tok-coalesced', 'tok-coalesced', 'tok-coalesced']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('clear() removes all cached entries', async () => {
    const cache = new GoogleCloudTokenCache();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ accessToken: 'tok-1', expiresAtMs: Date.now() + 3600 * 1000 })
      .mockResolvedValueOnce({ accessToken: 'tok-2', expiresAtMs: Date.now() + 3600 * 1000 });
    await cache.getToken('key1', fetcher);
    cache.clear();
    await cache.getToken('key1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('propagates fetcher errors without poisoning the inflight map', async () => {
    const cache = new GoogleCloudTokenCache();
    const fetcher = vi.fn().mockRejectedValue(new Error('Auth failed'));
    await expect(cache.getToken('key1', fetcher)).rejects.toThrow('Auth failed');
    // After an error, a second call should attempt a fresh fetch
    const fetcher2 = vi.fn().mockResolvedValue({
      accessToken: 'tok-recovered',
      expiresAtMs: Date.now() + 3600 * 1000,
    });
    const result = await cache.getToken('key1', fetcher2);
    expect(result).toBe('tok-recovered');
  });
});

// ── 4. synthesizeWithCloudTts ─────────────────────────────────────────────────

describe('Stage 3 — synthesizeWithCloudTts', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeTokenCache(token = 'test-bearer-token'): GoogleCloudTokenCache {
    const cache = new GoogleCloudTokenCache();
    vi.spyOn(cache, 'getToken').mockResolvedValue(token);
    return cache;
  }

  function makeSuccessResponse(base64Audio = Buffer.from('fake-mp3').toString('base64')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ audioContent: base64Audio }),
    };
  }

  it('returns an MP3 buffer on a successful synthesis', async () => {
    const fakeAudio = Buffer.from('fake-mp3-data');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse(fakeAudio.toString('base64'))));

    const result = await synthesizeWithCloudTts({
      text: 'She stepped into the rain.',
      voiceName: 'Kore',
      tokenCacheOverride: makeTokenCache(),
    });

    expect(result.audioBuffer).toBeInstanceOf(Buffer);
    expect(result.audioBuffer.toString()).toBe('fake-mp3-data');
    expect(result.strippedTags).toHaveLength(0);
  });

  it('sends Authorization bearer header and correct model', async () => {
    let capturedRequest: { headers: Record<string, string>; body: unknown } | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedRequest = {
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string),
      };
      return Promise.resolve(makeSuccessResponse());
    }));

    await synthesizeWithCloudTts({
      text: 'The city never slept.',
      voiceName: 'Orus',
      stylePrompt: 'Read with quiet tension.',
      tokenCacheOverride: makeTokenCache('my-token'),
    });

    expect(capturedRequest!.headers['Authorization']).toBe('Bearer my-token');
    const body = capturedRequest!.body as Record<string, unknown>;
    expect((body.voice as Record<string, unknown>).modelName).toBe(CLOUD_TTS_MODEL);
    expect((body.input as Record<string, unknown>).prompt).toBe('Read with quiet tension.');
  });

  it('strips disallowed tags before sending, records them in result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeSuccessResponse()));

    const result = await synthesizeWithCloudTts({
      text: '[scared] What is that thing?',
      voiceName: 'Kore',
      tokenCacheOverride: makeTokenCache(),
    });

    expect(result.strippedTags).toContain('[scared]');
  });

  it('passes allowed tags through unchanged', async () => {
    let sentText = '';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      sentText = (body.input as Record<string, unknown>).text as string;
      return Promise.resolve(makeSuccessResponse());
    }));

    await synthesizeWithCloudTts({
      text: '[sigh] I cannot believe it.',
      voiceName: 'Kore',
      tokenCacheOverride: makeTokenCache(),
    });

    expect(sentText).toContain('[sigh]');
  });

  it('throws CloudTtsInputError when text exceeds safe byte limit', async () => {
    const bigText = 'x'.repeat(CLOUD_TTS_SAFE_TEXT_BYTES + 1);
    await expect(
      synthesizeWithCloudTts({ text: bigText, voiceName: 'Kore', tokenCacheOverride: makeTokenCache() }),
    ).rejects.toThrow(CloudTtsInputError);
  });

  it('throws CloudTtsInputError when style prompt exceeds safe byte limit', async () => {
    const bigPrompt = 'y'.repeat(CLOUD_TTS_SAFE_PROMPT_BYTES + 1);
    await expect(
      synthesizeWithCloudTts({
        text: 'Short text.',
        voiceName: 'Kore',
        stylePrompt: bigPrompt,
        tokenCacheOverride: makeTokenCache(),
      }),
    ).rejects.toThrow(CloudTtsInputError);
  });

  it('throws CloudTtsInputError for empty voice name', async () => {
    await expect(
      synthesizeWithCloudTts({ text: 'Hello.', voiceName: '', tokenCacheOverride: makeTokenCache() }),
    ).rejects.toThrow(CloudTtsInputError);
  });

  it('throws CloudTtsApiError on non-OK HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid voice name' } }),
    }));

    await expect(
      synthesizeWithCloudTts({ text: 'Hello.', voiceName: 'BadVoice', tokenCacheOverride: makeTokenCache() }),
    ).rejects.toThrow(CloudTtsApiError);
  });

  it('evicts token cache on 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Unauthenticated' } }),
    }));

    const cache = new GoogleCloudTokenCache();
    const evictSpy = vi.spyOn(cache, 'evict');
    vi.spyOn(cache, 'getToken').mockResolvedValue('expired-token');

    await expect(
      synthesizeWithCloudTts({ text: 'Hello.', voiceName: 'Kore', tokenCacheOverride: cache }),
    ).rejects.toThrow(CloudTtsApiError);

    expect(evictSpy).toHaveBeenCalled();
  });

  it('throws CloudTtsApiError when audioContent is missing from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ someOtherField: 'value' }),
    }));

    await expect(
      synthesizeWithCloudTts({ text: 'Hello.', voiceName: 'Kore', tokenCacheOverride: makeTokenCache() }),
    ).rejects.toThrow(CloudTtsApiError);
  });

  it('does not include input.prompt in request when no prompt', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(makeSuccessResponse());
    }));

    await synthesizeWithCloudTts({
      text: 'Plain narration.',
      voiceName: 'Orus',
      tokenCacheOverride: makeTokenCache(),
    });

    expect((capturedBody!.input as Record<string, unknown>).prompt).toBeUndefined();
  });

  it('uses default language code en-US when not specified', async () => {
    let sentVoice: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      sentVoice = body.voice as Record<string, unknown>;
      return Promise.resolve(makeSuccessResponse());
    }));

    await synthesizeWithCloudTts({
      text: 'Hello.',
      voiceName: 'Kore',
      tokenCacheOverride: makeTokenCache(),
    });

    expect(sentVoice!.languageCode).toBe('en-US');
  });
});

// ── 5. Constants cross-check ───────────────────────────────────────────────────

describe('Stage 3 — byte limit constants', () => {
  it('safe limits are below the hard cap', () => {
    expect(CLOUD_TTS_SAFE_TEXT_BYTES).toBeLessThan(4000);
    expect(CLOUD_TTS_SAFE_PROMPT_BYTES).toBeLessThan(4000);
  });

  it('safe text limit is 3600', () => {
    expect(CLOUD_TTS_SAFE_TEXT_BYTES).toBe(3600);
  });

  it('safe prompt limit is 3600', () => {
    expect(CLOUD_TTS_SAFE_PROMPT_BYTES).toBe(3600);
  });

  it('CLOUD_TTS_MODEL is gemini-3.1-flash-tts-preview', () => {
    expect(CLOUD_TTS_MODEL).toBe('gemini-3.1-flash-tts-preview');
  });
});
