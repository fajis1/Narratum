import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GEMINI_VOICE_CATALOG_CACHE_TTL_MS,
  getLegacyGeminiFeaturedVoiceFallback,
  resetGeminiVoiceCatalogMemoryCacheForTests,
  resolveGeminiPrebuiltVoiceCatalog,
} from '../../src/lib/server/smart-audio/gemini-voice-catalog-cache';
import type { GeminiVoiceCatalogSnapshot } from '../../src/lib/server/smart-audio/gemini-voice-catalog-cache';
import { GeminiVoiceCatalogApiError } from '../../src/lib/server/smart-audio/gemini-voice-catalog-client';
import type { GeminiVoiceCatalogFetchResult } from '../../src/lib/server/smart-audio/gemini-voice-catalog-client';

const voices = [{
  id: 'Kore', displayName: 'Kore', languageCode: 'en-US', regionCode: 'US', accent: 'American',
  gender: 'female' as const, pitch: 'medium' as const, persona: 'Narrator', context: 'Audiobook',
  description: 'Clear', type: 'prebuilt' as const, model: null, expireTime: null,
}];

function fetchResult(fetchedAt: number): GeminiVoiceCatalogFetchResult {
  return { voices, languageCodes: ['en-US', 'en-GB'], fetchedAt, pageCount: 1 };
}

function snapshot(fetchedAt = 10): GeminiVoiceCatalogSnapshot {
  return {
    version: 1,
    catalogVersion: 'known-good',
    fetchedAt,
    languageCodes: ['en-US', 'en-GB'],
    voices,
  };
}

describe('Gemini voice catalog cache', () => {
  beforeEach(() => resetGeminiVoiceCatalogMemoryCacheForTests());

  it('uses a fresh process cache without another upstream request', async () => {
    let clock = 1_000;
    const fetchCatalog = vi.fn().mockResolvedValue(fetchResult(clock));
    const writeSnapshot = vi.fn().mockResolvedValue(undefined);
    const first = await resolveGeminiPrebuiltVoiceCatalog({ apiKey: 'key', now: () => clock, fetchCatalog, writeSnapshot });
    clock += 1;
    const second = await resolveGeminiPrebuiltVoiceCatalog({ apiKey: 'key', now: () => clock, fetchCatalog, writeSnapshot });

    expect(first.source).toBe('live');
    expect(second.source).toBe('cache');
    expect(fetchCatalog).toHaveBeenCalledOnce();
    expect(writeSnapshot).toHaveBeenCalledOnce();
  });

  it('refreshes an expired cache and ignores legacy locale options', async () => {
    let clock = 1_000;
    const fetchCatalog = vi.fn().mockImplementation(() => Promise.resolve(fetchResult(clock)));
    const base = { apiKey: 'key', now: () => clock, fetchCatalog, writeSnapshot: vi.fn().mockResolvedValue(undefined) };
    await resolveGeminiPrebuiltVoiceCatalog(base);
    clock += GEMINI_VOICE_CATALOG_CACHE_TTL_MS + 1;
    await resolveGeminiPrebuiltVoiceCatalog(base);
    await resolveGeminiPrebuiltVoiceCatalog({ ...base, languageCodes: ['en-GB'] });

    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });

  it('uses a durable last-known-good snapshot if the live catalog is unavailable', async () => {
    const readSnapshot = vi.fn().mockResolvedValue(snapshot());
    const result = await resolveGeminiPrebuiltVoiceCatalog({
      apiKey: 'key',
      fetchCatalog: vi.fn().mockRejectedValue(new Error('upstream unavailable')),
      readSnapshot,
      writeSnapshot: vi.fn(),
    });

    expect(result).toMatchObject({ source: 'snapshot', catalogVersion: 'known-good', voices });
    expect(readSnapshot).toHaveBeenCalledOnce();
  });

  it('uses the legacy featured catalog only as the final emergency fallback', async () => {
    const result = await resolveGeminiPrebuiltVoiceCatalog({
      apiKey: 'key',
      fetchCatalog: vi.fn().mockRejectedValue(new Error('upstream unavailable')),
      readSnapshot: vi.fn().mockResolvedValue(null),
      writeSnapshot: vi.fn(),
    });

    expect(result.source).toBe('legacy-fallback');
    expect(result.voices).toEqual(getLegacyGeminiFeaturedVoiceFallback());
    expect(result.voices).toHaveLength(30);
  });

  it('keeps a snapshot usable while exposing a safe authentication failure notice', async () => {
    const result = await resolveGeminiPrebuiltVoiceCatalog({
      apiKey: 'key',
      fetchCatalog: vi.fn().mockRejectedValue(new GeminiVoiceCatalogApiError('bad key', 401, 'bad key')),
      readSnapshot: vi.fn().mockResolvedValue(snapshot()),
      writeSnapshot: vi.fn(),
    });
    expect(result).toMatchObject({ source: 'snapshot', statusNotice: { code: 'authentication' } });
    expect(result.statusNotice?.message).not.toContain('bad key');
  });

  it('continues serving a live response when snapshot persistence fails', async () => {
    const result = await resolveGeminiPrebuiltVoiceCatalog({
      apiKey: 'key',
      fetchCatalog: vi.fn().mockResolvedValue(fetchResult(50)),
      writeSnapshot: vi.fn().mockRejectedValue(new Error('database temporarily unavailable')),
    });
    expect(result.source).toBe('live');
    expect(result.voices).toEqual(voices);
  });
});
