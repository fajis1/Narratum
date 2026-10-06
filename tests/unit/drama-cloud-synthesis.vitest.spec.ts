import { describe, expect, it, vi } from 'vitest';
import {
  annotateDramaChunks, splitDramaTextByUtf8, synthesizeDramaSegment, synthesizeGeminiDramaSegment,
} from '../../src/lib/server/smart-audio/drama-cloud-synthesis';
import { CloudTtsApiError, CloudTtsTransportError, measureUtf8Bytes } from '../../src/lib/server/smart-audio/google-cloud-tts-client';
import { GeminiTtsApiError, GeminiTtsQuotaExhaustedError } from '../../src/lib/server/smart-audio/gemini-tts-client';
import type { DramaDirectorSegment } from '../../src/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '../../src/types/document-settings';

const segment: DramaDirectorSegment = {
  speaker: 'Hero', utteranceType: 'spoken-dialogue', text: 'Hello there.',
  sceneContext: 'Hero enters the room.', omit_from_audio: false,
  performance: {
    primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'informing',
    delivery: ['natural'], pace: 'normal', energy: 'low', intensity: 'low', tags: [],
  },
};
const characterMap: SmartAudioCharacterMap = {
  schemaVersion: 1, status: 'complete', scannedAt: 1,
  entries: { Hero: { name: 'Hero', description: 'Steady voice.', sampleText: '', voiceId: 'Kore' } },
};
const success = { audioBuffer: Buffer.from('audio'), credentialCacheKey: 'test', strippedTags: [] };

describe('Drama Cloud synthesis', () => {
  it('splits Unicode text by bytes without losing a character or space', () => {
    const text = 'First sentence. 😀😀😀 Second sentence! Last bit.';
    const chunks = splitDramaTextByUtf8(text, 20);
    expect(chunks.join('')).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(measureUtf8Bytes(chunk)).toBeLessThanOrEqual(20);
  });

  it('prefers an earlier completed sentence over whitespace inside synthetic open dialogue', () => {
    const limit = 120;
    const input = `Narration begins. ${'filler '.repeat(7)}A safe boundary. ${'filler '.repeat(4)}"Before we leave there are several forms I need you to fill out and return to the office."`;
    const chunks = splitDramaTextByUtf8(input, limit);
    expect(chunks.join('')).toBe(input);
    expect(chunks[0]).toMatch(/A safe boundary\. /);
    expect(chunks[0]).not.toContain('fill ');
    expect(chunks[0].includes('"')).toBe(false);
    for (const chunk of chunks) expect(measureUtf8Bytes(chunk)).toBeLessThanOrEqual(limit);
  });

  it('prefers a paragraph boundary over a later sentence or whitespace boundary', () => {
    const input = `${'first '.repeat(10)}\n\n${'second '.repeat(8)}A later sentence. ${'tail '.repeat(10)}`;
    const chunks = splitDramaTextByUtf8(input, 120);
    expect(chunks[0]).toBe(`${'first '.repeat(10)}\n\n`);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every((chunk) => measureUtf8Bytes(chunk) <= 120)).toBe(true);
  });

  it('preserves quotes, apostrophes, markup and multibyte text across safe boundaries', () => {
    const limit = 70;
    const input = `“Don't change Bethany's [name](/neɪm/)… Καλημέρα 😀.” ${'filler '.repeat(12)} “A complete sentence.”`;
    const chunks = splitDramaTextByUtf8(input, limit);
    expect(chunks.join('')).toBe(input);
    expect(chunks.join('')).toContain('[name](/neɪm/)');
    expect(chunks.join('')).toContain('… Καλημέρα 😀');
    for (const chunk of chunks) expect(measureUtf8Bytes(chunk)).toBeLessThanOrEqual(limit);
  });

  it('falls back safely for very long dialogue, spaces only, and no whitespace', () => {
    for (const input of [`"${'word '.repeat(80)}"`, 'word '.repeat(100), '😀'.repeat(80)]) {
      const chunks = splitDramaTextByUtf8(input, 40);
      expect(chunks.join('')).toBe(input);
      expect(chunks.every((chunk) => measureUtf8Bytes(chunk) <= 40)).toBe(true);
      expect(chunks.every(Boolean)).toBe(true);
    }
  });

  it('uses a safe completed sentence for the exact 12,000-byte Director limit', () => {
    const limit = 12_000;
    const safePrefix = `${'n'.repeat(11_000)}. `;
    const input = `${safePrefix}"${'fill out '.repeat(300)}"`;
    const chunks = splitDramaTextByUtf8(input, limit);
    expect(measureUtf8Bytes(input)).toBeGreaterThan(limit);
    expect(chunks[0]).toBe(safePrefix);
    expect(chunks[0].includes('"')).toBe(false);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every((chunk) => measureUtf8Bytes(chunk) <= limit)).toBe(true);
  });

  it('permits an in-quote fallback for dialogue longer than the byte limit without mutation', () => {
    const limit = 12_000;
    const input = `"${'long dialogue '.repeat(1_200)}"`;
    const chunks = splitDramaTextByUtf8(input, limit);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startsWith('"')).toBe(true);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every((chunk) => measureUtf8Bytes(chunk) <= limit)).toBe(true);
  });

  it('does not split pronunciation markup internally when another legal boundary exists', () => {
    const input = `${'lead '.repeat(8)}[You](/ju/) ${'tail '.repeat(20)}`;
    const chunks = splitDramaTextByUtf8(input, 55);
    expect(chunks.join('')).toBe(input);
    expect(chunks.every((chunk) => measureUtf8Bytes(chunk) <= 55)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes('[You](/ju/)'))).toBe(true);
    expect(chunks.every((chunk) => !chunk.includes('[You](/') || chunk.includes('[You](/ju/)'))).toBe(true);
  });

  it('puts one-shot cues once, style cues on each chunk, and pause at the end', () => {
    expect(annotateDramaChunks(['Hello ', 'world.'], ['sigh', 'whispering', 'long pause'])).toEqual([
      '[sigh] [whispering] Hello ', '[whispering] world. [long pause]',
    ]);
  });

  it('synthesizes a long text in byte-safe chunks and retains source order', async () => {
    const text = '😀'.repeat(1000);
    const synthesize = vi.fn().mockResolvedValue(success);
    const result = await synthesizeDramaSegment({
      segment: { ...segment, text, performance: { ...segment.performance, tags: ['sigh'] } },
      characterMap, synthesize,
    });
    expect(result.reviewFlags).toEqual([expect.objectContaining({ kind: 'cloud-tts-split' })]);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.map((chunk) => chunk.sourceText).join('')).toBe(text);
    expect(result.chunks[0].requestText).toContain('[sigh]');
    expect(result.chunks[1].requestText).not.toContain('[sigh]');
    for (const chunk of result.chunks) expect(measureUtf8Bytes(chunk.requestText)).toBeLessThanOrEqual(3600);
  });

  it('retries transient failures and keeps a failed chunk with a review flag', async () => {
    const synthesize = vi.fn()
      .mockRejectedValue(new CloudTtsApiError('busy', 503, 'busy'));
    const wait = vi.fn().mockResolvedValue(undefined);
    const result = await synthesizeDramaSegment({ segment, characterMap, synthesize, wait });
    expect(synthesize).toHaveBeenCalledTimes(12); // 4 models * 3 retries
    expect(wait).toHaveBeenCalledTimes(8); // 2 waits per model * 4 models
    expect(result.chunks[0]).toMatchObject({ sourceText: segment.text, audioBuffer: null, needsPlaceholder: true });
    expect(result.reviewFlags[0]).toMatchObject({ speaker: 'Hero', sourceText: segment.text, attempts: 12, reason: 'Cloud TTS HTTP 503' });
  });

  it('tries simplified and neutral direction after a content failure, preserving exact text', async () => {
    const synthesize = vi.fn().mockRejectedValue(new CloudTtsApiError('bad input', 400, 'bad input'));
    const failed = await synthesizeDramaSegment({ segment, characterMap, synthesize });
    expect(synthesize).toHaveBeenCalledTimes(6); // 4 models + 2 simplified prompts
    expect(synthesize.mock.calls.map(([options]) => options.text)).toEqual([
      segment.text, segment.text, segment.text, segment.text, segment.text, segment.text,
    ]);
    expect(failed.reviewFlags[0].attempts).toBe(6);
    const omitted = await synthesizeDramaSegment({ segment: { ...segment, omit_from_audio: true }, characterMap, synthesize });
    expect(omitted.chunks[0]).toMatchObject({ sourceText: segment.text, omitted: true, needsPlaceholder: false });
    expect(synthesize).toHaveBeenCalledTimes(6); // omitting does not call synthesize
  });

  it('records a successful neutral fallback after simplified direction fails', async () => {
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new CloudTtsApiError('content', 400, 'bad input')) // model 1
      .mockRejectedValueOnce(new CloudTtsApiError('content', 400, 'bad input')) // model 2
      .mockRejectedValueOnce(new CloudTtsApiError('content', 400, 'bad input')) // model 3
      .mockRejectedValueOnce(new CloudTtsApiError('content', 400, 'bad input')) // model 4
      .mockRejectedValueOnce(new CloudTtsApiError('content', 400, 'bad input')) // prompt 1
      .mockResolvedValueOnce(success); // prompt 2 (neutral fallback)
    const result = await synthesizeDramaSegment({ segment, characterMap, synthesize });
    expect(result.chunks[0].audioBuffer).toEqual(success.audioBuffer);
    expect(result.reviewFlags).toEqual([expect.objectContaining({ kind: 'tts-fallback-used', attempts: 6 })]);
    expect(synthesize.mock.calls[5][0].stylePrompt).toContain('clearly and naturally');
  });

  it('retries a transient transport failure', async () => {
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new CloudTtsTransportError(new Error('connection reset')))
      .mockResolvedValueOnce(success);
    const result = await synthesizeDramaSegment({ segment, characterMap, synthesize, wait: async () => {} });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(result.reviewFlags).toEqual([expect.objectContaining({ kind: 'tts-retry-used', attempts: 2 })]);
    expect(result.chunks[0].audioBuffer).toEqual(success.audioBuffer);
  });

  it('uses Flash-Lite after the primary Gemini TTS model is unavailable', async () => {
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new GeminiTtsApiError('missing', 404, 'not found', 'gemini-3.8-flash-tts'))
      .mockResolvedValueOnce({ audioBuffer: Buffer.from('RIFF0000WAVEfmt ') });
    const result = await synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'test', synthesize });
    expect(synthesize.mock.calls.map(([options]) => options.modelName)).toEqual(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']);
    expect(result.reviewFlags).toEqual([expect.objectContaining({ kind: 'tts-fallback-used' })]);
  });

  it('bubbles an exhausted Gemini TTS quota instead of producing silence', async () => {
    const synthesize = vi.fn().mockRejectedValue(new GeminiTtsApiError('limited', 429, 'limited', 'gemini-3.8-flash-tts', 'RESOURCE_EXHAUSTED', 12_000));
    await expect(synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'test', synthesize, wait: async () => {} })).rejects.toMatchObject({
      name: 'GeminiTtsQuotaExhaustedError', retryAfterMs: 12_000,
    });
    expect(GeminiTtsQuotaExhaustedError).toBeDefined();
  });

  it('tries the primary model chain before the backup and preserves the same transcript and voice', async () => {
    const wait = vi.fn();
    const synthesize = vi.fn().mockImplementation(async (options) => {
      if (options.apiKey === 'primary') throw new GeminiTtsApiError('quota', 429, 'quota', options.modelName, 'RESOURCE_EXHAUSTED', 18_914_000);
      return { audioBuffer: Buffer.from('backup audio') };
    });
    const result = await synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize, wait });
    expect(synthesize.mock.calls.map(([o]) => [o.apiKey, o.modelName])).toEqual([
      ['primary', 'gemini-3.8-flash-tts'], ['primary', 'gemini-3.8-flash-lite-tts'], ['backup', 'gemini-3.8-flash-tts'],
    ]);
    const [first, , backup] = synthesize.mock.calls.map(([o]) => o);
    expect(backup).toEqual({ ...first, apiKey: 'backup' });
    expect(result.chunks[0].audioBuffer).toEqual(Buffer.from('backup audio'));
    expect(result.reviewFlags).toEqual([expect.objectContaining({ kind: 'tts-fallback-used', attempts: 3, reason: expect.stringContaining('backup API key') })]);
    expect(wait).not.toHaveBeenCalled();
  });

  it('tries the backup fallback model before yielding and keeps the longest Retry-After', async () => {
    const synthesize = vi.fn().mockImplementation(async (options) => {
      throw new GeminiTtsApiError('quota', 429, 'quota', options.modelName, 'RESOURCE_EXHAUSTED', options.apiKey === 'primary' ? 18_914_000 : 12_000);
    });
    await expect(synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize }))
      .rejects.toMatchObject({ name: 'GeminiTtsQuotaExhaustedError', retryAfterMs: 18_914_000 });
    expect(synthesize.mock.calls.map(([o]) => [o.apiKey, o.modelName])).toEqual([
      ['primary', 'gemini-3.8-flash-tts'], ['primary', 'gemini-3.8-flash-lite-tts'],
      ['backup', 'gemini-3.8-flash-tts'], ['backup', 'gemini-3.8-flash-lite-tts'],
    ]);
  });

  it('can recover on the backup fallback model', async () => {
    const synthesize = vi.fn().mockRejectedValueOnce(new GeminiTtsApiError('quota', 429, '', 'gemini-3.8-flash-tts'))
      .mockRejectedValueOnce(new GeminiTtsApiError('quota', 429, '', 'gemini-3.8-flash-lite-tts'))
      .mockRejectedValueOnce(new GeminiTtsApiError('missing', 404, '', 'gemini-3.8-flash-tts'))
      .mockResolvedValueOnce({ audioBuffer: Buffer.from('audio') });
    const result = await synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize });
    expect(synthesize).toHaveBeenCalledTimes(4);
    expect(result.chunks[0].needsPlaceholder).toBe(false);
  });

  it('does not turn quota exhaustion into silence when the backup has a different failure', async () => {
    const synthesize = vi.fn().mockImplementation(async options => {
      throw new GeminiTtsApiError('failed', options.apiKey === 'primary' ? 429 : 403, '', options.modelName, undefined, 12_000);
    });
    await expect(synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize }))
      .rejects.toMatchObject({ name: 'GeminiTtsQuotaExhaustedError', retryAfterMs: 12_000 });
    expect(synthesize).toHaveBeenCalledTimes(4);
  });

  it('uses the backup when primary access is denied', async () => {
    const synthesize = vi.fn().mockImplementation(async options => {
      if (options.apiKey === 'primary') throw new GeminiTtsApiError('denied', 403, '', options.modelName);
      return { audioBuffer: Buffer.from('audio') };
    });
    const result = await synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize });
    expect(result.chunks[0].needsPlaceholder).toBe(false);
    expect(synthesize).toHaveBeenCalledTimes(3);
  });

  it('does not use the backup when the primary succeeds', async () => {
    const synthesize = vi.fn().mockResolvedValue({ audioBuffer: Buffer.from('audio') });
    const result = await synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize });
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize.mock.calls[0][0].apiKey).toBe('primary');
    expect(result.reviewFlags).toEqual([]);
  });

  it.each(['', '  ', ' primary '])('does not retry a missing or duplicate backup key (%j)', async backupApiKey => {
    const synthesize = vi.fn().mockRejectedValue(new GeminiTtsApiError('quota', 429, '', 'gemini-3.8-flash-tts'));
    await expect(synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey, synthesize }))
      .rejects.toBeInstanceOf(GeminiTtsQuotaExhaustedError);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('does not use another key for invalid input', async () => {
    const synthesize = vi.fn().mockRejectedValue(new GeminiTtsApiError('input', 400, '', 'gemini-3.8-flash-tts'));
    const result = await synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize });
    expect(synthesize.mock.calls.every(([o]) => o.apiKey === 'primary')).toBe(true);
    expect(result.reviewFlags[0].kind).toBe('cloud-tts-failed');
  });

  it('propagates cancellation without trying another model or key', async () => {
    const controller = new AbortController();
    const synthesize = vi.fn().mockImplementation(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    await expect(synthesizeGeminiDramaSegment({ segment, characterMap, apiKey: 'primary', backupApiKey: 'backup', synthesize, signal: controller.signal }))
      .rejects.toThrow();
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it('preserves whitespace-only Director segments without making a TTS request', async () => {
    const synthesize = vi.fn();
    const text = '\n\n  \t';
    const result = await synthesizeGeminiDramaSegment({ segment: { ...segment, text }, characterMap, apiKey: 'test', synthesize });
    expect(synthesize).not.toHaveBeenCalled();
    expect(result.chunks.map((chunk) => chunk.sourceText).join('')).toBe(text);
    expect(result.chunks[0]).toMatchObject({ omitted: true, needsPlaceholder: false });
    expect(result.reviewFlags).toEqual([]);
  });

  it('preserves trailing whitespace chunks without an empty request', async () => {
    const text = 'Hello.' + ' '.repeat(4000);
    const synthesize = vi.fn().mockResolvedValue({ audioBuffer: Buffer.from('audio') });
    const result = await synthesizeGeminiDramaSegment({ segment: { ...segment, text }, characterMap, apiKey: 'test', synthesize });
    expect(result.chunks.map((chunk) => chunk.sourceText).join('')).toBe(text);
    expect(synthesize).toHaveBeenCalledOnce();
    expect(result.reviewFlags).toEqual([]);
  });

  it('retains request-building errors as explicit failed chunks', async () => {
    const synthesize = vi.fn();
    const result = await synthesizeGeminiDramaSegment({ segment, characterMap: { ...characterMap, entries: {} }, apiKey: 'test', synthesize });
    expect(synthesize).not.toHaveBeenCalled();
    expect(result.chunks[0]).toMatchObject({ sourceText: segment.text, needsPlaceholder: true });
    expect(result.reviewFlags).toEqual([expect.objectContaining({ kind: 'cloud-tts-failed' })]);
  });

  it('flags preflight failures without losing source text', async () => {
    const result = await synthesizeDramaSegment({ segment: { ...segment, text: '[quest] Go.' }, characterMap });
    expect(result.chunks[0].sourceText).toBe('[quest] Go.');
    expect(result.chunks[0].needsPlaceholder).toBe(true);
    expect(result.reviewFlags).toHaveLength(1);
  });
});
