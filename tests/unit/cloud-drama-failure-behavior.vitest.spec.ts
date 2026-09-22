import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ direct: vi.fn(), synthesize: vi.fn(), concat: vi.fn(), silent: vi.fn() }));
vi.mock('@/lib/server/smart-audio/drama-director', () => ({ directDramaWithGemini: mocks.direct }));
vi.mock('@/lib/server/smart-audio/drama-cloud-synthesis', () => ({
  synthesizeDramaSegment: mocks.synthesize,
  splitDramaTextByUtf8: (text: string) => [text],
}));
vi.mock('@/lib/server/audiobooks/segmented-tts', () => ({
  concatenateMp3Segments: mocks.concat,
  generateSilentMp3Segment: mocks.silent,
}));

const cast = { schemaVersion: 1, status: 'complete', entries: {
  Narrator: { name: 'Narrator', description: '', sampleText: '', voiceId: 'Kore' },
} } as any;
const segment = {
  speaker: 'Narrator', utteranceType: 'narration', text: 'A short line.', sceneContext: 'A scene.', omit_from_audio: false,
  performance: { primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'none', delivery: ['natural'], pace: 'normal', energy: 'normal', intensity: 'controlled', tags: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.direct.mockResolvedValue([segment]);
  mocks.concat.mockResolvedValue(Buffer.from('joined'));
  mocks.silent.mockResolvedValue(Buffer.from('silence'));
});

describe('Cloud Drama failed segment behavior', () => {
  it('stops after bounded retries when stop-job is selected and retains review flags', async () => {
    mocks.synthesize.mockResolvedValue({ chunks: [{ sourceText: segment.text, requestText: segment.text, audioBuffer: null, needsPlaceholder: true, omitted: false }], reviewFlags: [{ kind: 'cloud-tts-failed', speaker: 'Narrator', sourceText: segment.text, chunkIndex: 0, attempts: 3, reason: 'CloudTtsApiError' }] });
    const { generateCloudDramaAudiobook, CloudDramaGenerationError } = await import('@/lib/server/audiobooks/cloud-drama');
    await expect(generateCloudDramaAudiobook({ cleanedText: segment.text, characterMap: cast, geminiApiKey: 'gemini', directorModel: 'model', dramaGeminiTtsSettings: { failedSegmentBehavior: 'stop-job' } })).rejects.toMatchObject({ name: 'CloudDramaGenerationError', reviewFlags: [{ speaker: 'Narrator' }] });
    expect(mocks.concat).not.toHaveBeenCalled();
    expect(CloudDramaGenerationError).toBeDefined();
  });

  it('continues and returns stitched audio when continue-and-flag is selected', async () => {
    mocks.synthesize.mockResolvedValue({ chunks: [{ sourceText: segment.text, requestText: segment.text, audioBuffer: null, needsPlaceholder: true, omitted: false }], reviewFlags: [{ kind: 'cloud-tts-failed', speaker: 'Narrator', sourceText: segment.text, chunkIndex: 0, attempts: 3, reason: 'CloudTtsApiError' }] });
    const { generateCloudDramaAudiobook } = await import('@/lib/server/audiobooks/cloud-drama');
    const result = await generateCloudDramaAudiobook({ cleanedText: segment.text, characterMap: cast, geminiApiKey: 'gemini', directorModel: 'model', dramaGeminiTtsSettings: { failedSegmentBehavior: 'continue-and-flag' } });
    expect(result.audioBuffer).toEqual(Buffer.from('joined'));
    expect(result.reviewFlags).toHaveLength(1);
    expect(mocks.silent).toHaveBeenCalledOnce();
  });
});
