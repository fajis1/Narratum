import { describe, expect, it, vi } from 'vitest';
import { synthesizeDramaSegment } from '../../src/lib/server/smart-audio/drama-cloud-synthesis';
import {
  CloudTtsApiError,
  CloudTtsQuotaExhaustedError,
  resolveCloudTtsModelFallbacks,
} from '../../src/lib/server/smart-audio/google-cloud-tts-client';
import {
  GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE,
  calculateRemainingDailyQuotaMs,
} from '../../src/lib/shared/audiobook-job-status';
import { isAudiobookJobEligibleToRun } from '../../src/lib/server/audiobooks/queue-eligibility';
import { resolveDramaDirectorModel } from '../../src/lib/shared/smart-audio-models';
import type { DramaDirectorSegment } from '../../src/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '../../src/types/document-settings';

const testSegment: DramaDirectorSegment = {
  speaker: 'Narrator',
  utteranceType: 'narration',
  text: 'The dawn was quiet across the harbor.',
  sceneContext: 'Early morning in the harbor.',
  omit_from_audio: false,
  performance: {
    primaryEmotion: 'calm',
    secondaryEmotions: [],
    socialIntent: 'informing',
    delivery: ['natural'],
    pace: 'normal',
    energy: 'normal',
    intensity: 'medium',
    tags: [],
  },
};

const testCharacterMap: SmartAudioCharacterMap = {
  schemaVersion: 1,
  status: 'complete',
  scannedAt: 1,
  entries: {
    Narrator: {
      name: 'Narrator',
      description: 'The narrator voice.',
      sampleText: '',
      voiceId: 'Kore',
    },
  },
};

describe('Cloud TTS Model Fallback (3.8 -> 3.7 -> 3.6)', () => {
  it('defaults to 3.8 and resolves fallbacks to 3.7 and 3.6', () => {
    const chain = resolveCloudTtsModelFallbacks();
    expect(chain[0]).toBe('gemini-3.8-flash-tts');
    expect(chain).toContain('gemini-3.7-flash-tts');
    expect(chain).toContain('gemini-3.6-flash-tts');
  });

  it('falls back from 3.8 to 3.7 when 3.8 hits 429 quota exhaustion', async () => {
    const triedModels: string[] = [];
    const mockSynthesize = vi.fn().mockImplementation((options: { modelName?: string }) => {
      triedModels.push(options.modelName || 'default');
      if (options.modelName === 'gemini-3.8-flash-tts') {
        throw new CloudTtsApiError('Quota exceeded', 429, 'RESOURCE_EXHAUSTED');
      }
      return Promise.resolve({
        audioBuffer: Buffer.from('fake-mp3-audio-3.7'),
        credentialCacheKey: 'test',
        strippedTags: [],
        usedModel: options.modelName || 'gemini-3.7-flash-tts',
      });
    });

    const result = await synthesizeDramaSegment({
      segment: testSegment,
      characterMap: testCharacterMap,
      synthesize: mockSynthesize,
      maxAttempts: 1,
    });

    expect(triedModels).toContain('gemini-3.8-flash-tts');
    expect(triedModels).toContain('gemini-3.7-flash-tts');
    expect(result.chunks[0].audioBuffer).toEqual(Buffer.from('fake-mp3-audio-3.7'));
    expect(result.reviewFlags.some((f) => f.kind === 'tts-fallback-used' && f.reason.includes('gemini-3.7-flash-tts'))).toBe(true);
  });

  it('falls back from 3.8 -> 3.7 -> 3.6 when both 3.8 and 3.7 fail', async () => {
    const triedModels: string[] = [];
    const mockSynthesize = vi.fn().mockImplementation((options: { modelName?: string }) => {
      triedModels.push(options.modelName || 'default');
      if (options.modelName === 'gemini-3.8-flash-tts' || options.modelName === 'gemini-3.7-flash-tts') {
        throw new CloudTtsApiError('Quota exceeded', 429, 'RESOURCE_EXHAUSTED');
      }
      return Promise.resolve({
        audioBuffer: Buffer.from('fake-mp3-audio-3.6'),
        credentialCacheKey: 'test',
        strippedTags: [],
        usedModel: options.modelName || 'gemini-3.6-flash-tts',
      });
    });

    const result = await synthesizeDramaSegment({
      segment: testSegment,
      characterMap: testCharacterMap,
      synthesize: mockSynthesize,
      maxAttempts: 1,
    });

    expect(triedModels).toContain('gemini-3.8-flash-tts');
    expect(triedModels).toContain('gemini-3.7-flash-tts');
    expect(triedModels).toContain('gemini-3.6-flash-tts');
    expect(result.chunks[0].audioBuffer).toEqual(Buffer.from('fake-mp3-audio-3.6'));
    expect(result.reviewFlags.some((f) => f.kind === 'tts-fallback-used' && f.reason.includes('gemini-3.6-flash-tts'))).toBe(true);
  });

  it('throws CloudTtsQuotaExhaustedError when all candidate models fail with 429 quota exhaustion', async () => {
    const mockSynthesize = vi.fn().mockImplementation(() => {
      throw new CloudTtsApiError('Quota exceeded on all models', 429, 'RESOURCE_EXHAUSTED');
    });

    await expect(synthesizeDramaSegment({
      segment: testSegment,
      characterMap: testCharacterMap,
      synthesize: mockSynthesize,
      maxAttempts: 1,
    })).rejects.toThrow(CloudTtsQuotaExhaustedError);
  });
});

describe('Smart Error Handling / Queue Eligibility for Daily Quota', () => {
  it('pauses job in queue until nextAttemptAt when daily quota is exhausted', () => {
    const now = Date.now();
    const remainingMs = calculateRemainingDailyQuotaMs(now);
    const nextAttemptAt = now + remainingMs;

    const row = {
      id: 'job-quota-exhausted',
      error: GOOGLE_CLOUD_TTS_DAILY_PAUSE_MESSAGE,
      updatedAt: now,
      settingsJson: JSON.stringify({ nextAttemptAt }),
    };

    const activeSet = new Set<string>();

    // Before nextAttemptAt expires: NOT eligible
    expect(isAudiobookJobEligibleToRun(row, activeSet, now)).toBe(false);

    // After nextAttemptAt arrives: ELIGIBLE to resume automatically!
    expect(isAudiobookJobEligibleToRun(row, activeSet, nextAttemptAt + 1000)).toBe(true);
  });

  it('resolveDramaDirectorModel defaults to gemini-3.8-flash', () => {
    expect(resolveDramaDirectorModel(null)).toBe('gemini-3.8-flash');
    expect(resolveDramaDirectorModel(undefined)).toBe('gemini-3.8-flash');
    expect(resolveDramaDirectorModel({})).toBe('gemini-3.8-flash');
    expect(resolveDramaDirectorModel({ aiModel: 'custom-model' })).toBe('custom-model');
  });
});
