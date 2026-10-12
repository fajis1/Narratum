import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { inspectDramaWav } from '@/lib/server/audiobooks/drama-audio-effects';

function previewWav() {
  const audio = Buffer.alloc(44 + 9600);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8); audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(24000, 24); audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(9600, 40);
  for (let i = 0; i < 4800; i++) audio.writeInt16LE(Math.round(Math.sin(i / 24000 * 440 * 2 * Math.PI) * 5000), 44 + i * 2);
  return audio;
}

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), profiles: vi.fn(), synthesize: vi.fn(), catalog: vi.fn(), getStoredPreview: vi.fn(), putStoredPreview: vi.fn(), rows: [] as unknown[][],
}));

vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.auth }));
vi.mock('@/lib/server/smart-audio-profiles', () => ({
  readSmartAudioProfilesDocument: mocks.profiles,
  findSmartAudioProfileById: (profiles: any[], id: string) => profiles.find((profile) => profile.id === id),
}));
vi.mock('@/lib/server/smart-audio/google-cloud-tts-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/smart-audio/google-cloud-tts-client')>('@/lib/server/smart-audio/google-cloud-tts-client');
  return { ...actual, synthesizeWithCloudTts: mocks.synthesize };
});
vi.mock('@/lib/server/smart-audio/gemini-tts-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/smart-audio/gemini-tts-client')>('@/lib/server/smart-audio/gemini-tts-client');
  return { ...actual, synthesizeWithGeminiTts: mocks.synthesize };
});
vi.mock('@/lib/server/smart-audio/gemini-voice-catalog-cache', () => ({
  resolveGeminiPrebuiltVoiceCatalog: mocks.catalog,
}));
vi.mock('@/lib/server/smart-audio/gemini-voice-preview-cache', () => ({
  getStoredGeminiVoicePreview: mocks.getStoredPreview,
  putStoredGeminiVoicePreview: mocks.putStoredPreview,
}));
vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => mocks.rows.shift() ?? [] }),
      }),
    }),
  },
}));

const profile = {
  id: 'profile-1', workerMode: 'drama-gemini-tts',
  geminiApiKey: 'test-gemini-key',
  googleCloudServiceAccountJson: '{"project_id":"private"}',
  dramaGeminiTtsSettings: { languageCode: 'en-GB', dramaStyle: 'cinematic' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: 'user-1' });
  mocks.profiles.mockResolvedValue([profile]);
  mocks.synthesize.mockResolvedValue({ audioBuffer: Buffer.from('wav'), mimeType: 'audio/wav' });
  mocks.catalog.mockResolvedValue({ source: 'live', fetchedAt: 1, catalogVersion: 'test', languageCodes: ['en-US'], voices: [{ id: 'Kore', model: 'gemini-3.8-flash-tts' }] });
  mocks.getStoredPreview.mockResolvedValue(null);
  mocks.putStoredPreview.mockResolvedValue(undefined);
  mocks.rows = [];
});

describe('Gemini Audio Drama connection route', () => {
  it('performs a minimal Gemini connection test without exposing profile secrets', async () => {
    const { POST } = await import('@/app/api/tts-settings/google-cloud/test/route');
    const response = await POST(new NextRequest('http://localhost/api/tts-settings/google-cloud/test', {
      method: 'POST', body: JSON.stringify({ profileId: 'profile-1' }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: profile.geminiApiKey, text: 'This is a Narratum Gemini connection test.',
    }));
    expect(JSON.stringify(await response.json())).not.toContain('private');
  });

  it('sanitizes provider failures', async () => {
    mocks.synthesize.mockRejectedValue(new Error('private key and bearer token leaked'));
    const { POST } = await import('@/app/api/tts-settings/google-cloud/test/route');
    const body = await (await POST(new NextRequest('http://localhost/api/tts-settings/google-cloud/test', {
      method: 'POST', body: JSON.stringify({ profileId: 'profile-1' }),
    }))).json();
    expect(body.error).toContain('Gemini 3.8 TTS connection failed');
    expect(JSON.stringify(body)).not.toContain('private key');
    expect(JSON.stringify(body)).not.toContain('bearer token');
  });
});
describe('Gemini character preview route', () => {
  const request = (extra: Record<string, unknown> = {}) => new NextRequest('http://localhost/api/audiobook/characters/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: 'doc-1', profileId: 'profile-1', voiceName: 'Kore', text: 'Hello there.', ...extra }),
  });

  beforeEach(() => {
    mocks.rows = [
      [{ id: 'doc-1' }],
      [{ dataJson: JSON.stringify({ smartAudioCharacters: {
        schemaVersion: 1, status: 'complete', entries: {
          Rina: { name: 'Rina', description: 'Guarded.', voiceId: 'Kore', cloudDirection: { audioProfile: 'Quiet and controlled.' } },
        },
      } }) }],
    ];
  });

  it('keeps voice-only previews neutral and reaches Gemini with the profile API key', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'voice-only' }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: profile.geminiApiKey, voiceName: 'Kore', modelName: 'gemini-3.8-flash-tts',
      text: 'The lantern glowed softly as the evening train disappeared beyond the hills.',
    }));
    expect(mocks.synthesize.mock.calls[0][0].style).toContain('neutral audiobook voice comparison');
    expect(mocks.putStoredPreview).toHaveBeenCalledWith(expect.any(String), Buffer.from('wav'), 'audio/wav');
  });

  it('previews a Lite-catalog voice with the Lite model', async () => {
    mocks.catalog.mockResolvedValue({ source: 'live', fetchedAt: 1, catalogVersion: 'test', languageCodes: ['en-US'], voices: [{ id: 'LiteVoice', model: 'gemini-3.8-flash-lite-tts' }] });
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'voice-only', voiceName: 'LiteVoice' }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      voiceName: 'LiteVoice', modelName: 'gemini-3.8-flash-lite-tts',
    }));
  });

  it('previews with explicit modelName requested in the body', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'voice-only', modelName: 'gemini-3.8-flash-lite-tts' }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gemini-3.8-flash-lite-tts',
    }));
  });

  it('previews character using entry.ttsModel when modelName is not in body', async () => {
    mocks.rows = [
      [{ id: 'doc-1' }],
      [{ dataJson: JSON.stringify({ smartAudioCharacters: {
        schemaVersion: 1, status: 'complete', entries: {
          Rina: { name: 'Rina', description: 'Guarded.', voiceId: 'Kore', ttsModel: 'gemini-3.8-flash-lite-tts', cloudDirection: { audioProfile: 'Quiet and controlled.' } },
        },
      } }) }],
    ];
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'character', characterName: 'Rina' }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'gemini-3.8-flash-lite-tts',
    }));
  });

  it('reuses a stored neutral voice sample without calling Gemini again', async () => {
    mocks.catalog.mockResolvedValue({ source: 'live', fetchedAt: 1, catalogVersion: 'test', languageCodes: ['en-US'], voices: [{ id: 'KoreStored' }] });
    mocks.getStoredPreview.mockResolvedValue(Buffer.from('stored-wav'));
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'voice-only', voiceName: 'KoreStored' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Narratum-Preview-Cache')).toBe('PERSISTENT_HIT');
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('uses saved direction for character previews', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'character', characterName: 'Rina' }));
    expect(response.status).toBe(200);
    const style = mocks.synthesize.mock.calls[0][0].style as string;
    expect(style).toContain('Quiet and controlled.');
    expect(style).toContain('concise audiobook performance');
  });

  it('synthesizes chapter-title previews with the configured title voice rather than the character voice', async () => {
    mocks.catalog.mockResolvedValue({ voices: [{ id: 'Kore' }, { id: 'Puck' }] });
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'scene', characterName: 'Rina', utteranceType: 'chapter-title', text: 'Chapter 8: Arrival',
      chapterTitles: { enabled: true, voiceId: 'Puck' } }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: 'Chapter 8: Arrival', voiceName: 'Puck' }));
    expect(mocks.synthesize.mock.calls[0][0].style).toContain('Announce this chapter title');
    expect(mocks.synthesize.mock.calls[0][0].style).not.toContain('Quiet and controlled');
  });

  it('bounds scene input and does not expose or persist manuscript content', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'scene', characterName: 'Rina', sceneContext: 'x'.repeat(2_000), text: 'y'.repeat(500) }));
    expect(response.status).toBe(200);
    const style = mocks.synthesize.mock.calls[0][0].style as string;
    expect(style).not.toContain('x'.repeat(501));
    expect(mocks.synthesize.mock.calls[0][0].text).toHaveLength(300);
  });

  it('rejects a scene preview without a saved character', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'scene', characterName: 'Missing' }));
    expect(response.status).toBe(400);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('changes only local effects on cached scene audio and matches the selected speech delivery', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    mocks.synthesize.mockResolvedValue({ audioBuffer: previewWav(), mimeType: 'audio/wav' });
    const settings = (effect: string) => ({ 'squad-link': { effect, strength: 60, delivery: 'urgent', radioTexture: 'both' } });
    const first = await POST(request({ previewMode: 'scene', characterName: 'Rina', utteranceType: 'squad-link', sceneContext: 'Unique effect preview.', speechTypes: settings('clean') }));
    expect(first.status).toBe(200);
    const clean = Buffer.from(await first.arrayBuffer());
    expect(mocks.synthesize).toHaveBeenCalledOnce();
    expect(mocks.synthesize.mock.calls[0][0].style).toContain('urgent delivery');
    mocks.rows = [[{ id: 'doc-1' }], [{ dataJson: JSON.stringify({ smartAudioCharacters: { schemaVersion: 1, status: 'complete', entries: {
      Rina: { name: 'Rina', description: 'Guarded.', voiceId: 'Kore', cloudDirection: { audioProfile: 'Quiet and controlled.' } },
    } } }) }]];
    const second = await POST(request({ previewMode: 'scene', characterName: 'Rina', utteranceType: 'squad-link', sceneContext: 'Unique effect preview.', speechTypes: settings('cb-radio') }));
    expect(second.status).toBe(200); expect(second.headers.get('X-Narratum-Preview-Cache')).toBe('HIT');
    const treated = Buffer.from(await second.arrayBuffer());
    expect(treated).not.toEqual(clean); expect(inspectDramaWav(treated)?.durationMs).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledOnce();
  });

  it('rejects invalid speech type or direction before requesting preview audio', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    expect((await POST(request({ previewMode: 'scene', characterName: 'Rina', utteranceType: 'unrecognized' }))).status).toBe(400);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
