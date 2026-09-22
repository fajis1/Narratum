import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const generateTTSBuffer = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/tts/generate', () => ({
  generateTTSBuffer,
}));

import { generateSegmentedAudiobookTtsBuffer, generateSilentMp3Segment } from '../../src/lib/server/audiobooks/segmented-tts';
import { AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS } from '../../src/lib/shared/audiobook-batching';

describe('segmented audiobook TTS generation', () => {
  beforeEach(async () => {
    generateTTSBuffer.mockReset();
    generateTTSBuffer.mockResolvedValue(
      await readFile(path.join(process.cwd(), 'tests/files/sample.mp3')),
    );
  });

  test('uses multiple bounded TTS requests and returns one valid combined MP3', async () => {
    const text = Array.from(
      { length: 45 },
      (_, index) => `Sentence ${index} ${'spoken words '.repeat(12).trim()}.`,
    ).join(' ');
    expect(text.length).toBeGreaterThan(AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS);

    const combined = await generateSegmentedAudiobookTtsBuffer({
      text,
      voice: 'test',
      speed: 1,
      provider: 'test',
      apiKey: 'test-placeholder',
    });
    const requests = generateTTSBuffer.mock.calls.map(([request]) => request);

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => (
      request.text.length <= AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS
    ))).toBe(true);
    expect(combined.length).toBeGreaterThan(0);
    expect(combined.subarray(0, 3).toString('ascii')).toBe('ID3');
  });

  test('uses each reviewed voice for valid tagged segments', async () => {
    await generateSegmentedAudiobookTtsBuffer({
      text: '<voice name="af_heart">Narration.</voice>\n<voice name="am_adam">Dialogue.</voice>',
      voice: 'fallback',
      speed: 1,
      provider: 'test',
      apiKey: 'test-placeholder',
    });

    expect(generateTTSBuffer.mock.calls.map(([request]) => request.voice)).toEqual(['af_heart', 'am_adam']);
  });

  test('rejects unknown voices and untagged text instead of speaking it with the fallback voice', async () => {
    await expect(generateSegmentedAudiobookTtsBuffer({
      text: '<voice name="invented_voice">Dialogue.</voice>',
      voice: 'fallback',
      speed: 1,
      provider: 'test',
      apiKey: 'test-placeholder',
    })).rejects.toThrow(/unsupported voice/i);
    await expect(generateSegmentedAudiobookTtsBuffer({
      text: 'Leaked narration. <voice name="af_heart">Tagged narration.</voice>',
      voice: 'fallback',
      speed: 1,
      provider: 'test',
      apiKey: 'test-placeholder',
    })).rejects.toThrow(/outside a voice segment/i);
    expect(generateTTSBuffer).not.toHaveBeenCalled();
  });

  test('creates a valid MP3 silence placeholder for failed Cloud Drama lines', async () => {
    const silence = await generateSilentMp3Segment();
    expect(silence.length).toBeGreaterThan(0);
    expect(silence.subarray(0, 3).toString('ascii')).toBe('ID3');
  });
});
