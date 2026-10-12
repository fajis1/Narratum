import { describe, expect, it, vi } from 'vitest';
import { normalizeDramaSpeechSettings } from '@/lib/shared/drama-speech-settings';
import { buildDramaDirectorPolicy } from '@/lib/shared/drama-profile-settings';
import { applyDramaAudioEffect, inspectDramaWav } from '@/lib/server/audiobooks/drama-audio-effects';
import { GeminiDramaQuotaTracker } from '@/lib/server/smart-audio/gemini-drama-quota';
import { synthesizeGeminiDramaSegment } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { buildGeminiDramaTtsRequest } from '@/lib/server/smart-audio/drama-cloud-request';
import { GeminiTtsApiError, type GeminiTtsSynthesisOptions } from '@/lib/server/smart-audio/gemini-tts-client';
import { groupDramaRecoveryNotices, isDramaRecoveryNotice } from '@/lib/shared/drama-diagnostic-notices';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
vi.mock('@/lib/server/logger', () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

export function speechWav(milliseconds = 200): Buffer {
  const samples = Math.round(24 * milliseconds);
  const audio = Buffer.alloc(44 + samples * 2);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) audio.writeInt16LE(Math.round(5000 * Math.sin(i / 24000 * 440 * 2 * Math.PI)), 44 + i * 2);
  return audio;
}
const segment: DramaDirectorSegment = { speaker: 'Hero', utteranceType: 'squad-link', text: 'Ready.', sceneContext: 'The squad checks in.', omit_from_audio: false,
  performance: { primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'informing', delivery: ['natural'], pace: 'normal', energy: 'low', intensity: 'low', tags: [] } };
const map: SmartAudioCharacterMap = { schemaVersion: 1, status: 'complete', scannedAt: 1, entries: { Hero: { name: 'Hero', description: '', sampleText: '', voiceId: 'Kore' } } };

describe('speech type sounds and quota recovery', () => {
  it('normalizes legacy settings to clean independent defaults and bounds effect strength', () => {
    const settings = normalizeDramaSpeechSettings({ 'squad-link': { effect: 'cb-radio', strength: 500, delivery: 'urgent', radioTexture: 'both' }, narration: { effect: 'untrusted-filter', strength: NaN } });
    expect(settings['squad-link']).toEqual({ effect: 'cb-radio', strength: 100, delivery: 'urgent', radioTexture: 'both' });
    expect(settings.narration.effect).toBe('clean');
    settings.narration.strength = 99;
    expect(normalizeDramaSpeechSettings().narration.strength).toBe(35);
  });

  it.each(['cb-radio', 'mental-link', 'inner-voice'] as const)('processes %s with real offline FFmpeg and retains valid PCM and full duration', async effect => {
    const raw = speechWav();
    const setting = { ...normalizeDramaSpeechSettings()['squad-link'], effect, strength: 60, radioTexture: 'both' as const };
    const treated = await applyDramaAudioEffect(raw, setting);
    const info = inspectDramaWav(treated)!;
    expect(info.durationMs).toBeGreaterThanOrEqual(200);
    expect(info.durationMs).toBeLessThanOrEqual(251);
    expect(info.channels).toBe(1); expect(info.sampleRate).toBe(24000);
    expect(treated.readUInt32LE(4)).toBe(treated.length - 8);
    expect(treated.readUInt32LE(info.dataOffset - 4)).toBe(info.dataBytes);
    expect(treated).not.toEqual(raw);
    expect(inspectDramaWav(raw)?.durationMs).toBe(200);
  });

  it('clean and zero strength are byte-exact, while cancellation never starts processing', async () => {
    const raw = speechWav(); const setting = normalizeDramaSpeechSettings()['squad-link'];
    expect(await applyDramaAudioEffect(raw, setting)).toBe(raw);
    expect(await applyDramaAudioEffect(raw, { ...setting, effect: 'cb-radio', strength: 0 })).toBe(raw);
    const controller = new AbortController(); controller.abort();
    await expect(applyDramaAudioEffect(raw, setting, controller.signal)).rejects.toThrow();
  });

  it('delivery changes style metadata while preserving voice and transcript', () => {
    const speechTypes = normalizeDramaSpeechSettings({ 'squad-link': { delivery: 'urgent', effect: 'cb-radio' } });
    const built = buildGeminiDramaTtsRequest({ segment, characterMap: map, policy: buildDramaDirectorPolicy({ speechTypes }) });
    expect(built.style).toContain('urgent delivery'); expect(built.voiceName).toBe('Kore'); expect(built.sourceText).toBe(segment.text);
    expect(built.requestText).toBe(segment.text);
    expect(built.style).not.toContain('cb-radio');
  });

  it('skips exhausted primary models for 131 further turns, including restored next-chapter state', async () => {
    let now = 1000; const onChange = vi.fn();
    const tracker = new GeminiDramaQuotaTracker(undefined, () => now, onChange);
    const synthesize = vi.fn(async (options: GeminiTtsSynthesisOptions) => {
      if (options.apiKey === 'primary-fixture') throw new GeminiTtsApiError('Daily quota', 429, 'quota', options.modelName!, 'RESOURCE_EXHAUSTED', 6 * 3600_000);
      return { audioBuffer: speechWav(), audioFormat: 'wav' as const, mimeType: 'audio/wav' as const, sampleRate: 24000 as const, usedModel: options.modelName! };
    });
    const input = { segment, characterMap: map, apiKey: 'primary-fixture', backupApiKey: 'backup-fixture', synthesize };
    await synthesizeGeminiDramaSegment({ ...input, quotaTracker: tracker });
    now += 100;
    const restored = new GeminiDramaQuotaTracker(JSON.parse(JSON.stringify(tracker.snapshot())), () => now);
    for (let i = 0; i < 131; i++) await synthesizeGeminiDramaSegment({ ...input, quotaTracker: restored });
    expect(synthesize.mock.calls.filter(([options]) => options.apiKey === 'primary-fixture')).toHaveLength(2);
    expect(synthesize.mock.calls.filter(([options]) => options.apiKey === 'backup-fixture')).toHaveLength(132);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(tracker.snapshot())).not.toContain('primary-fixture');
    now += 6 * 3600_000;
    expect(restored.remaining('primary-fixture', 'gemini-3.8-flash-tts')).toBe(0);
    expect(restored.remaining('changed-key', 'gemini-3.8-flash-tts')).toBe(0);
  });

  it('schedules the earliest independent cooldown without issuing requests when all are cooling', async () => {
    const tracker = new GeminiDramaQuotaTracker(undefined, () => 1000);
    for (const key of ['primary-fixture', 'backup-fixture']) for (const model of ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'] as const) await tracker.defer(key, model, key.startsWith('backup') ? 12000 : 6 * 3600_000);
    const synthesize = vi.fn();
    await expect(synthesizeGeminiDramaSegment({ segment, characterMap: map, apiKey: 'primary-fixture', backupApiKey: 'backup-fixture', quotaTracker: tracker, synthesize, deferProviderFailures: true }))
      .rejects.toMatchObject({ name: 'GeminiTtsQuotaExhaustedError', retryAfterMs: 12000 });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('groups successful fallbacks but preserves failed Director validation as a concern', () => {
    const flags = Array.from({ length: 131 }, (_, index) => ({ id: String(index), chapterIndex: 1, timestampMs: 0, createdAt: 1, kind: 'tts-fallback-used' as const, reason: 'Backup succeeded.' }));
    expect(groupDramaRecoveryNotices(flags)).toEqual([{ chapterIndex: 1, kind: 'tts-fallback-used', reason: 'Backup succeeded.', count: 131 }]);
    expect(isDramaRecoveryNotice({ kind: 'director-validation-repair', reason: 'Drama Director output failed validation: speaker missing.' })).toBe(false);
    expect(isDramaRecoveryNotice({ kind: 'director-validation-repair', reason: 'Director output required validation repair 1.' })).toBe(true);
  });
});
