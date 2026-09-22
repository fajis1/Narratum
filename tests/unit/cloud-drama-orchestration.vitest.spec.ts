import { beforeEach, describe, expect, it, vi } from 'vitest';

const { direct, synthesize, concatenate, silence } = vi.hoisted(() => ({
  direct: vi.fn(), synthesize: vi.fn(), concatenate: vi.fn(), silence: vi.fn(),
}));

vi.mock('../../src/lib/server/smart-audio/drama-director', () => ({ directDramaWithGemini: direct }));
vi.mock('../../src/lib/server/smart-audio/drama-cloud-synthesis', () => ({
  synthesizeDramaSegment: synthesize,
  splitDramaTextByUtf8: (text: string) => [text],
}));
vi.mock('../../src/lib/server/audiobooks/segmented-tts', () => ({
  concatenateMp3Segments: concatenate,
  generateSilentMp3Segment: silence,
}));

import { generateCloudDramaAudiobook } from '../../src/lib/server/audiobooks/cloud-drama';
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
      cleanedText: 'Hello.', characterMap: map, geminiApiKey: 'test', directorModel: 'gemini-test',
    });
    expect(direct).toHaveBeenCalledWith(expect.objectContaining({ sourceText: 'Hello.', castNames: ['Narrator'] }));
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      characterMap: expect.objectContaining({ entries: expect.objectContaining({ Narrator: expect.objectContaining({ voiceId: 'Kore' }) }) }),
    }));
    expect(concatenate).toHaveBeenCalledWith([Buffer.from('spoken')], undefined);
    expect(result.audioBuffer).toEqual(Buffer.from('chapter'));
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
});
