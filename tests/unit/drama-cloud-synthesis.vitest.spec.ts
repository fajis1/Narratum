import { describe, expect, it, vi } from 'vitest';
import {
  annotateDramaChunks, splitDramaTextByUtf8, synthesizeDramaSegment,
} from '../../src/lib/server/smart-audio/drama-cloud-synthesis';
import { CloudTtsApiError, CloudTtsTransportError, measureUtf8Bytes } from '../../src/lib/server/smart-audio/google-cloud-tts-client';
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
    expect(result.reviewFlags).toEqual([]);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.map((chunk) => chunk.sourceText).join('')).toBe(text);
    expect(result.chunks[0].requestText).toContain('[sigh]');
    expect(result.chunks[1].requestText).not.toContain('[sigh]');
    for (const chunk of result.chunks) expect(measureUtf8Bytes(chunk.requestText)).toBeLessThanOrEqual(3600);
  });

  it('retries transient failures and keeps a failed chunk with a review flag', async () => {
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new CloudTtsApiError('busy', 503, 'busy'))
      .mockRejectedValueOnce(new CloudTtsApiError('busy', 503, 'busy'))
      .mockRejectedValueOnce(new CloudTtsApiError('busy', 503, 'busy'));
    const wait = vi.fn().mockResolvedValue(undefined);
    const result = await synthesizeDramaSegment({ segment, characterMap, synthesize, wait });
    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(result.chunks[0]).toMatchObject({ sourceText: segment.text, audioBuffer: null, needsPlaceholder: true });
    expect(result.reviewFlags[0]).toMatchObject({ speaker: 'Hero', sourceText: segment.text, attempts: 3, reason: 'Cloud TTS HTTP 503' });
  });

  it('does not retry permanent failures and leaves omitted text explicit', async () => {
    const synthesize = vi.fn().mockRejectedValue(new CloudTtsApiError('bad input', 400, 'bad input'));
    const failed = await synthesizeDramaSegment({ segment, characterMap, synthesize });
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(failed.reviewFlags[0].attempts).toBe(1);
    const omitted = await synthesizeDramaSegment({ segment: { ...segment, omit_from_audio: true }, characterMap, synthesize });
    expect(omitted.chunks[0]).toMatchObject({ sourceText: segment.text, omitted: true, needsPlaceholder: false });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('retries a transient transport failure', async () => {
    const synthesize = vi.fn()
      .mockRejectedValueOnce(new CloudTtsTransportError(new Error('connection reset')))
      .mockResolvedValueOnce(success);
    const result = await synthesizeDramaSegment({ segment, characterMap, synthesize, wait: async () => {} });
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(result.reviewFlags).toEqual([]);
    expect(result.chunks[0].audioBuffer).toEqual(success.audioBuffer);
  });

  it('flags preflight failures without losing source text', async () => {
    const result = await synthesizeDramaSegment({ segment: { ...segment, text: '[quest] Go.' }, characterMap });
    expect(result.chunks[0].sourceText).toBe('[quest] Go.');
    expect(result.chunks[0].needsPlaceholder).toBe(true);
    expect(result.reviewFlags).toHaveLength(1);
  });
});
