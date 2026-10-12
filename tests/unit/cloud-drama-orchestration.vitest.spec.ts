import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { direct, synthesize, concatenate, silence } = vi.hoisted(() => ({
  direct: vi.fn(), synthesize: vi.fn(), concatenate: vi.fn(), silence: vi.fn(),
}));

vi.mock('@/lib/server/smart-audio/gemini-cast-helpers', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/server/smart-audio/gemini-cast-helpers')>(),
  getGeminiTtsCharacterMapReadiness: async ({ value }: { value: unknown }) => ({ ready: true, map: value }),
}));
vi.mock('@/lib/server/logger', () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/lib/server/smart-audio/drama-director', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/server/smart-audio/drama-director')>(), directDramaWithGemini: direct,
}));
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
import { dramaCastHash } from '@/lib/server/audiobooks/drama-speaker-review';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';

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
  afterEach(() => vi.unstubAllGlobals());

  it.each(['valid', 'invalid'])('gates synthesis on actual Director validation after the structural fallback (%s metadata)', async validity => {
    const actual = await vi.importActual<typeof import('@/lib/server/smart-audio/drama-director')>('@/lib/server/smart-audio/drama-director');
    direct.mockImplementation(actual.directDramaWithGemini);
    const fetch = vi.fn().mockImplementation((_url, request) => {
      const config = JSON.parse(request.body).generationConfig;
      const schema = config.responseFormat?.text?.schema ?? config.responseJsonSchema;
      if (JSON.stringify(schema).includes('"enum"')) return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.' } }, { status: 400 });
      const { text: _text, ...metadata } = segment;
      void _text;
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ segments: [{
        ...metadata, spanIds: ['s000001'],
        performance: { ...segment.performance, primaryEmotion: validity === 'valid' ? 'calm' : 'friendly' },
      }] }) }] } }] });
    });
    vi.stubGlobal('fetch', fetch);
    synthesize.mockResolvedValue({ chunks: [{ audioBuffer: Buffer.from('spoken'), needsPlaceholder: false, omitted: false }], reviewFlags: [] });
    const generation = generateCloudDramaAudiobook({ cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'fixture', directorModel: 'gemini-test' });
    if (validity === 'valid') {
      expect((await generation).audioBuffer).toEqual(Buffer.from('chapter'));
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(synthesize).toHaveBeenCalledOnce();
      expect(synthesize.mock.calls[0][0].segment.text).toBe('Hello.');
      expect(synthesize.mock.calls[0][0].characterMap.entries.Narrator.voiceId).toBe('Kore');
    } else {
      await expect(generation).rejects.toThrow(/primaryEmotion/);
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(synthesize).not.toHaveBeenCalled();
      expect(concatenate).not.toHaveBeenCalled();
    }
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
    expect(result.reviewFlags).toEqual([{ ...flag, segmentNumber: 1, timestampMs: 0 }]);
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

  it('records corrected saved direction without calling the Director again', async () => {
    const reviewed = { schemaVersion: 1 as const, chapterIndex: 0, profileId: 'cloud', sourceText: 'Hello.', complete: true, preparedOnly: true,
      castHash: dramaCastHash(map), reviewedAt: 1, segments: [{ ...segment, utteranceType: 'squad-link', voiceId: 'Kore' }] };
    synthesize.mockResolvedValue({ chunks: [{ audioBuffer: Buffer.from('spoken'), needsPlaceholder: false, omitted: false }], reviewFlags: [] });
    const onDirectedSegments = vi.fn().mockResolvedValue(undefined);
    await generateCloudDramaAudiobook({ cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test',
      profileId: 'cloud', onDirectedSegments, savedReview: reviewed as import('@/lib/shared/drama-speaker-review').DramaSpeakerReview });
    expect(direct).not.toHaveBeenCalled();
    expect(synthesize.mock.calls[0][0].segment.utteranceType).toBe('squad-link');
    expect(synthesize.mock.calls[0][0].segment.text).toBe('Hello.');
    expect(onDirectedSegments.mock.calls[0][1]).toBe(true);
  });

  it('locates flags after real WAV durations including split chunks and the next spoken turn', async () => {
    const wav = (ms: number) => {
      const audio = Buffer.alloc(44 + ms * 48);
      audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
      audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28);
      audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40); return audio;
    };
    direct.mockResolvedValue([segment, { ...segment, text: 'Again.' }]);
    const flag = { kind: 'tts-fallback-used', speaker: 'Narrator', sourceText: 'Hello.', attempts: 2, reason: 'Recovered.' };
    synthesize.mockResolvedValueOnce({ chunks: [300, 200].map(ms => ({ audioBuffer: wav(ms), needsPlaceholder: false, omitted: false })),
      reviewFlags: [{ ...flag, chunkIndex: 1 }] }).mockResolvedValueOnce({ chunks: [{ audioBuffer: wav(100), needsPlaceholder: false, omitted: false }], reviewFlags: [{ ...flag, chunkIndex: 0 }] });
    const result = await generateCloudDramaAudiobook({ cleanedText: 'Hello.Again.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test' });
    expect(result.reviewFlags.map(flag => [flag.segmentNumber, flag.timestampMs])).toEqual([[1, 300], [2, 500]]);
  });

  it('refuses changed source or invalid corrected metadata before synthesizing', async () => {
    const reviewed = { schemaVersion: 1 as const, chapterIndex: 0, profileId: 'cloud', sourceText: 'Changed.', complete: true, preparedOnly: true,
      castHash: dramaCastHash(map), reviewedAt: 1, segments: [{ ...segment, voiceId: 'Kore' } as DramaDirectorSegment & { voiceId: string }] };
    await expect(generateCloudDramaAudiobook({ cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test',
      profileId: 'cloud', savedReview: reviewed })).rejects.toThrow(/no longer matches/);
    expect(direct).not.toHaveBeenCalled(); expect(synthesize).not.toHaveBeenCalled();
  });

  it.each([true, false])('records the saved metadata title only when enabled (%s)', async enabled => {
    direct.mockResolvedValue([segment]);
    synthesize.mockResolvedValue({ chunks: [{ audioBuffer: Buffer.from('spoken'), needsPlaceholder: false, omitted: false }], reviewFlags: [] });
    const result = await generateCloudDramaAudiobook({ cleanedText: 'Hello.', chapterTitle: 'Chapter 1: Arrival', characterMap: map,
      geminiApiKey: 'test', directorModel: 'gemini-test', dramaGeminiTtsSettings: { chapterTitles: { enabled, voiceId: 'Puck' } } });
    expect(synthesize.mock.calls.map(([input]) => [input.segment.utteranceType, input.segment.text])).toEqual(enabled
      ? [['chapter-title', 'Chapter 1: Arrival'], ['narration', 'Hello.']] : [['narration', 'Hello.']]);
    expect(result.segments.map(turn => turn.text).join('')).toBe('Hello.');
    expect(direct.mock.calls[0][0].sourceText).toBe('Hello.');
    if (enabled) expect(synthesize.mock.calls[0][0].policy.chapterTitles.voiceId).toBe('Puck');
  });

  it.each([true, false])('recognizes inline titles and avoids repeating an opening heading (%s)', async enabled => {
    direct.mockResolvedValue([{ ...segment, text: 'Chapter 1\n\nHello.\n\nChapter 2\n\nAgain.' }]);
    synthesize.mockResolvedValue({ chunks: [{ audioBuffer: Buffer.from('spoken'), needsPlaceholder: false, omitted: false }], reviewFlags: [] });
    const result = await generateCloudDramaAudiobook({ cleanedText: 'Chapter 1\n\nHello.\n\nChapter 2\n\nAgain.', chapterTitle: 'Chapter 1', characterMap: map,
      geminiApiKey: 'test', directorModel: 'gemini-test', dramaGeminiTtsSettings: { chapterTitles: { enabled, voiceId: 'Puck' } } });
    expect(synthesize.mock.calls.filter(([input]) => input.segment.utteranceType === 'chapter-title')).toHaveLength(enabled ? 2 : 0);
    expect(result.segments.filter(turn => turn.utteranceType === 'chapter-title')).toHaveLength(2);
    expect(result.segments.map(turn => turn.text).join('')).toBe('Chapter 1\n\nHello.\n\nChapter 2\n\nAgain.');
  });

  it('keeps a title-only chunk as silence when title recording is disabled, without any TTS request', async () => {
    direct.mockResolvedValue([{ ...segment, text: 'Chapter 1\n' }]);
    const result = await generateCloudDramaAudiobook({ cleanedText: 'Chapter 1\n', chapterTitle: 'Chapter 1', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test' });
    expect(synthesize).not.toHaveBeenCalled();
    expect(concatenate).toHaveBeenCalledWith([Buffer.from('silence')], undefined);
    expect(result.reviewFlags).toHaveLength(0);
    expect(result.segments[0].utteranceType).toBe('chapter-title');
  });

  it('persists the measured failed split position before stopping the recording', async () => {
    const audio = Buffer.alloc(44 + 300 * 48);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
    synthesize.mockResolvedValue({ chunks: [
      { audioBuffer: audio, needsPlaceholder: false, omitted: false },
      { audioBuffer: null, needsPlaceholder: true, omitted: false },
    ], reviewFlags: [{ kind: 'cloud-tts-failed', speaker: 'Narrator', sourceText: 'Hello.', chunkIndex: 1, attempts: 3, reason: 'Failed.' }] });
    const persisted: unknown[] = [];
    await expect(generateCloudDramaAudiobook({ cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test',
      dramaGeminiTtsSettings: { failedSegmentBehavior: 'stop-job' }, onSynthesisFailure: async flags => { persisted.push(JSON.parse(JSON.stringify(flags))); },
    })).rejects.toThrow(/stopped/);
    expect(persisted).toEqual([[expect.objectContaining({ segmentNumber: 1, timestampMs: 300 })]]);
    expect(silence).not.toHaveBeenCalled(); expect(concatenate).not.toHaveBeenCalled();
  });
});
