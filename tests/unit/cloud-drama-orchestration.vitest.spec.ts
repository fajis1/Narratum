import { beforeEach, describe, expect, it, vi } from 'vitest';

const { direct, synthesize, concatenate, silence } = vi.hoisted(() => ({
  direct: vi.fn(), synthesize: vi.fn(), concatenate: vi.fn(), silence: vi.fn(),
}));

vi.mock('@/lib/server/smart-audio/gemini-cast-helpers', () => ({
  getGeminiTtsCharacterMapReadiness: async ({ value }: { value: unknown }) => ({ ready: true, map: value }),
}));
vi.mock('../../src/lib/server/smart-audio/drama-director', () => ({ directDramaWithGemini: direct }));
vi.mock('../../src/lib/server/smart-audio/drama-cloud-synthesis', () => ({
  synthesizeGeminiDramaSegment: synthesize,
  splitDramaTextByUtf8: (text: string) => [text],
}));
vi.mock('../../src/lib/server/audiobooks/segmented-tts', () => ({
  concatenateWavSegmentsToMp3: concatenate,
  generateSilentWavSegment: silence,
}));

import { generateCloudDramaAudiobook } from '../../src/lib/server/audiobooks/cloud-drama';
import { DRAMA_DIRECTOR_MAX_SPANS } from '@/lib/server/smart-audio/drama-source-spans';
import type { SmartAudioCharacterMap } from '../../src/types/document-settings';

const map: SmartAudioCharacterMap = {
  schemaVersion: 1, status: 'complete', scannedAt: 1, profileId: 'cloud',
  entries: {
    Narrator: { name: 'Narrator', description: '', sampleText: '', voiceId: 'Kore' },
  },
};
const segment = {
  speaker: 'Narrator', text: 'Hello.', utteranceType: 'narration', sceneContext: 'Opening.',
  omit_from_audio: false,
  performance: { primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'informing', delivery: ['natural'], pace: 'normal', energy: 'low', intensity: 'low', tags: [] },
};

describe('Cloud Drama chapter orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    direct.mockResolvedValue([segment]);
    concatenate.mockResolvedValue(Buffer.from('chapter'));
    silence.mockResolvedValue(Buffer.from('silence'));
  });

  it('directs cleaned text, synthesizes with reviewed cast, and stitches audio', async () => {
    synthesize.mockResolvedValue({
      chunks: [{ sourceText: 'Hello.', requestText: 'Hello.', audioBuffer: Buffer.from('spoken'), needsPlaceholder: false, omitted: false }],
      reviewFlags: [],
    });
    const result = await generateCloudDramaAudiobook({
      cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', backupGeminiApiKey: 'backup', directorModel: 'gemini-test',
    });
    expect(direct).toHaveBeenCalledWith(expect.objectContaining({ sourceText: 'Hello.', castNames: ['Narrator'] }));
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test', backupApiKey: 'backup',
      characterMap: expect.objectContaining({ entries: expect.objectContaining({ Narrator: expect.objectContaining({ voiceId: 'Kore' }) }) }),
    }));
    expect(concatenate).toHaveBeenCalledWith([Buffer.from('spoken')], undefined);
    expect(result.audioBuffer).toEqual(Buffer.from('chapter'));
  });

  it('directs adaptive immutable chapter batches in order with continuity and diagnostics', async () => {
    const cleanedText = Array.from({ length: 100 }, (_, index) => `“Turn ${index}.” Narrator said.\n`).join('');
    const onLifecycle = vi.fn();
    direct.mockImplementation(async (options) => {
      options.onDiagnostic({ batchIndex: options.batchIndex, finishReason: 'STOP', sourceSpanCount: options.sourceSpans.length });
      return [{ ...segment, text: options.sourceText, sceneContext: `Batch ${options.batchIndex}.` }];
    });
    const result = await generateCloudDramaAudiobook({ cleanedText, characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test', directionOnly: true, onLifecycle });
    expect(direct.mock.calls.length).toBeGreaterThan(2);
    expect(result.segments.map((item) => item.text).join('')).toBe(cleanedText);
    const ids = direct.mock.calls.flatMap(([options]) => options.sourceSpans.map((span: { id: string }) => span.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const [index, [options]] of direct.mock.calls.entries()) {
      expect(options.sourceSpans.length).toBeLessThanOrEqual(DRAMA_DIRECTOR_MAX_SPANS);
      expect(Buffer.byteLength(options.sourceText)).toBeLessThanOrEqual(12_000);
      expect(options.batchIndex).toBe(index);
      if (index) expect(options.priorContinuityState).toBe(`Batch ${index - 1}.`);
    }
    expect(onLifecycle).toHaveBeenCalledWith('director.diagnostic', expect.objectContaining({ finishReason: 'STOP' }));
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('prepares speaker review without synthesizing or stitching audio', async () => {
    const onDirectedSegments = vi.fn().mockResolvedValue(undefined);
    const result = await generateCloudDramaAudiobook({
      cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test',
      directionOnly: true, onDirectedSegments,
    });
    expect(result.segments).toEqual([segment]);
    expect(onDirectedSegments).toHaveBeenCalledWith([segment], true);
    expect(synthesize).not.toHaveBeenCalled();
    expect(concatenate).not.toHaveBeenCalled();
  });

  it('retains validated speaker turns before TTS can fail', async () => {
    synthesize.mockRejectedValue(new Error('TTS failed'));
    const onDirectedSegments = vi.fn().mockResolvedValue(undefined);
    await expect(generateCloudDramaAudiobook({
      cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test', onDirectedSegments,
    })).rejects.toThrow('TTS failed');
    expect(onDirectedSegments).toHaveBeenCalledWith([segment], true);
    expect(onDirectedSegments.mock.invocationCallOrder[0]).toBeLessThan(synthesize.mock.invocationCallOrder[0]);
  });

  it('stitches silence in place of a failed line and returns its review flag', async () => {
    const flag = { kind: 'cloud-tts-failed', speaker: 'Narrator', sourceText: 'Hello.', chunkIndex: 0, attempts: 3, reason: 'Cloud TTS HTTP 503' };
    synthesize.mockResolvedValue({
      chunks: [{ sourceText: 'Hello.', requestText: 'Hello.', audioBuffer: null, needsPlaceholder: true, omitted: false }],
      reviewFlags: [flag],
    });
    const result = await generateCloudDramaAudiobook({
      cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test',
    });
    expect(concatenate).toHaveBeenCalledWith([Buffer.from('silence')], undefined);
    expect(result.reviewFlags).toEqual([flag]);
  });

  it('passes prior continuity into the Director and keeps repair diagnostics', async () => {
    direct.mockImplementationOnce(async (options) => {
      options.onRepair(1, ['invalid delivery']);
      return [segment];
    });
    synthesize.mockResolvedValue({
      chunks: [{ sourceText: 'Hello.', requestText: 'Hello.', audioBuffer: Buffer.from('spoken'), needsPlaceholder: false, omitted: false }],
      reviewFlags: [{ kind: 'tts-retry-used', speaker: 'Narrator', sourceText: 'Hello.', chunkIndex: 0, attempts: 2, reason: 'Recovered.' }],
    });
    const result = await generateCloudDramaAudiobook({
      cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test',
      priorContinuityState: 'The group has entered the room.',
      dramaGeminiTtsSettings: { failedSegmentBehavior: 'stop-job' },
    });
    expect(direct).toHaveBeenCalledWith(expect.objectContaining({ priorContinuityState: 'The group has entered the room.' }));
    expect(result.reviewFlags.map((flag) => flag.kind)).toEqual(['director-validation-repair', 'tts-retry-used']);
    expect(result.audioBuffer).toEqual(Buffer.from('chapter'));
  });
});
