import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGeminiVoiceCatalogUrl,
  fetchGeminiPrebuiltVoiceCatalog,
  GEMINI_VOICE_CATALOG_ENDPOINT,
  GeminiVoiceCatalogApiError,
  GeminiVoiceCatalogInputError,
  GeminiVoiceCatalogProtocolError,
  GeminiVoiceCatalogTransportError,
} from '../../src/lib/server/smart-audio/gemini-voice-catalog-client';
import {
  isSafeGeminiVoiceId,
  normalizeGeminiVoiceCatalogEntry,
} from '../../src/lib/shared/gemini-voice-catalog';

const apiKey = 'test-api-key';

function response(payload: unknown, options: { ok?: boolean; status?: number; retryAfter?: string } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: new Headers(options.retryAfter ? { 'retry-after': options.retryAfter } : {}),
    json: async () => payload,
  } as Response;
}

function voice(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    display_name: id,
    language_code: 'en-US',
    type: 'prebuilt',
    ...extra,
  };
}

describe('Gemini voice catalog normalization', () => {
  it('normalizes provider metadata and preserves unknown missing fields', () => {
    expect(normalizeGeminiVoiceCatalogEntry(voice('Kore', {
      display_name: ' Kore ', gender: 'FEMALE', pitch: 'Low', accent: 'American',
      persona: 'Narrator', context: 'Audiobook', description: 'Clear and warm.', region_code: 'US',
    }))).toEqual({
      id: 'Kore', displayName: 'Kore', languageCode: 'en-US', regionCode: 'US', accent: 'American',
      gender: 'female', pitch: 'low', persona: 'Narrator', context: 'Audiobook', description: 'Clear and warm.',
      type: 'prebuilt', model: null, expireTime: null,
    });
    expect(normalizeGeminiVoiceCatalogEntry(voice('Mystery', { gender: undefined, pitch: 'other' })))
      .toMatchObject({ gender: 'unknown', pitch: 'unknown' });
  });

  it('rejects incomplete records and only accepts syntactically safe future voice IDs', () => {
    expect(normalizeGeminiVoiceCatalogEntry({ id: 'MissingType' })).toBeNull();
    expect(isSafeGeminiVoiceId('voice_abc-123.4')).toBe(true);
    expect(isSafeGeminiVoiceId('voice with spaces')).toBe(false);
    expect(isSafeGeminiVoiceId('<voice>')).toBe(false);
  });
});

describe('Gemini Voices API client', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('uses the fixed endpoint and prebuilt upstream filter, then keeps all English variants locally', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(response({ voices: [voice('Kore')] }));
    }));

    const result = await fetchGeminiPrebuiltVoiceCatalog({ apiKey });
    const url = new URL(capturedUrl);
    expect(`${url.origin}${url.pathname}`).toBe(GEMINI_VOICE_CATALOG_ENDPOINT);
    expect(url.searchParams.get('page_size')).toBe('1000');
    expect(url.searchParams.getAll('type')).toEqual(['prebuilt']);
    expect(url.searchParams.getAll('language_code')).toEqual([]);
    expect(capturedInit).toMatchObject({ method: 'GET', headers: { 'x-goog-api-key': apiKey } });
    expect(result.voices.map((entry) => entry.id)).toEqual(['Kore']);
  });

  it('keeps all filters stable while paginating, dedupes IDs, and ignores non-prebuilt records', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      urls.push(url);
      return Promise.resolve(urls.length === 1
        ? response({ voices: [voice('Puck', { language_code: 'en-AU' }), voice('Kore'), voice('French', { language_code: 'fr-FR' }), voice('Custom', { type: 'prompted' })], next_page_token: 'page-2' })
        : response({ voices: [voice('Kore', { description: 'duplicate' }), voice('Charon', { language_code: 'en' }), { id: 'bad', type: 'prebuilt' }], next_page_token: '' }));
    }));

    const result = await fetchGeminiPrebuiltVoiceCatalog({ apiKey, languageCodes: ['en-GB', 'en-US'] });
    expect(result.pageCount).toBe(2);
    expect(result.voices.map((entry) => entry.id)).toEqual(['Charon', 'Kore', 'Puck']);
    expect(result.voices.map((entry) => entry.languageCode)).toEqual(['en', 'en-US', 'en-AU']);
    const first = new URL(urls[0]);
    const second = new URL(urls[1]);
    expect(second.searchParams.get('page_token')).toBe('page-2');
    expect(second.searchParams.getAll('language_code')).toEqual([]);
    expect(first.searchParams.getAll('language_code')).toEqual([]);
    expect(second.searchParams.getAll('type')).toEqual(first.searchParams.getAll('type'));
  });

  it('rejects malformed JSON shape, looping pagination, and invalid caller input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ voices: 'not-an-array' })));
    await expect(fetchGeminiPrebuiltVoiceCatalog({ apiKey })).rejects.toThrow(GeminiVoiceCatalogProtocolError);
    await expect(fetchGeminiPrebuiltVoiceCatalog({ apiKey: '' })).rejects.toThrow(GeminiVoiceCatalogInputError);
    await expect(fetchGeminiPrebuiltVoiceCatalog({ apiKey, languageCodes: ['not a language'] })).rejects.toThrow(GeminiVoiceCatalogInputError);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ voices: [], next_page_token: 'again' })));
    await expect(fetchGeminiPrebuiltVoiceCatalog({ apiKey, maxPages: 1 })).rejects.toThrow('safety limit');
  });

  it.each([
    [401, 'UNAUTHENTICATED', undefined],
    [403, 'PERMISSION_DENIED', undefined],
    [429, 'RESOURCE_EXHAUSTED', 2_000],
    [500, 'INTERNAL', undefined],
  ])('classifies HTTP %i failures without leaking a success result', async (status, providerStatus, retryAfterMs) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      error: { message: 'provider failure', status: providerStatus },
    }, { ok: false, status, retryAfter: retryAfterMs ? '2' : undefined })));

    const error = await fetchGeminiPrebuiltVoiceCatalog({ apiKey }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GeminiVoiceCatalogApiError);
    expect(error).toMatchObject({ statusCode: status, detail: 'provider failure', providerStatus, retryAfterMs });
  });

  it('wraps network failures and builds no arbitrary upstream URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchGeminiPrebuiltVoiceCatalog({ apiKey })).rejects.toThrow(GeminiVoiceCatalogTransportError);
    expect(buildGeminiVoiceCatalogUrl({ languageCodes: ['en-US'], pageToken: 'opaque' }))
      .toContain('https://generativelanguage.googleapis.com/v1beta/voices?');
  });
});
