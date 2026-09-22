import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), profiles: vi.fn(), synthesize: vi.fn(), rows: [] as unknown[][],
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
  googleCloudServiceAccountJson: '{"project_id":"private"}',
  dramaGeminiTtsSettings: { languageCode: 'en-GB', dramaStyle: 'cinematic' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: 'user-1' });
  mocks.profiles.mockResolvedValue([profile]);
  mocks.synthesize.mockResolvedValue({ audioBuffer: Buffer.from('mp3') });
  mocks.rows = [];
});

describe('Google Cloud Drama connection route', () => {
  it('performs a real synthesis-path check with normalized language and never returns credentials', async () => {
    const { POST } = await import('@/app/api/tts-settings/google-cloud/test/route');
    const response = await POST(new NextRequest('http://localhost/api/tts-settings/google-cloud/test', {
      method: 'POST', body: JSON.stringify({ profileId: 'profile-1' }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      languageCode: 'en-GB', serviceAccountJson: profile.googleCloudServiceAccountJson,
    }));
    expect(JSON.stringify(await response.json())).not.toContain('private');
  });

  it('sanitizes provider failures', async () => {
    mocks.synthesize.mockRejectedValue(new Error('private key and bearer token leaked'));
    const { POST } = await import('@/app/api/tts-settings/google-cloud/test/route');
    const body = await (await POST(new NextRequest('http://localhost/api/tts-settings/google-cloud/test', {
      method: 'POST', body: JSON.stringify({ profileId: 'profile-1' }),
    }))).json();
    expect(body.error).toContain('Authentication failed');
    expect(JSON.stringify(body)).not.toContain('private key');
    expect(JSON.stringify(body)).not.toContain('bearer token');
  });
});

describe('Cloud character preview route', () => {
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

  it('keeps voice-only previews neutral and reaches Cloud with the profile language', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'voice-only' }));
    expect(response.status).toBe(200);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ languageCode: 'en-GB' }));
    expect(mocks.synthesize.mock.calls[0][0].stylePrompt).toContain('neutral audiobook voice comparison');
  });

  it('uses saved direction and Stage 11 policy for character previews', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'character', characterName: 'Rina' }));
    expect(response.status).toBe(200);
    const prompt = mocks.synthesize.mock.calls[0][0].stylePrompt as string;
    expect(prompt).toContain('Quiet and controlled.');
    expect(prompt).toContain('overall style cinematic');
    expect(prompt).toContain('Character expressiveness: expressive.');
  });

  it('bounds scene input and does not expose or persist manuscript content', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'scene', characterName: 'Rina', sceneContext: 'x'.repeat(2_000), text: 'y'.repeat(500) }));
    expect(response.status).toBe(200);
    const prompt = mocks.synthesize.mock.calls[0][0].stylePrompt as string;
    expect(prompt).not.toContain('x'.repeat(501));
    expect(mocks.synthesize.mock.calls[0][0].text).toHaveLength(300);
  });

  it('rejects a scene preview without a saved character', async () => {
    const { POST } = await import('@/app/api/audiobook/characters/preview/route');
    const response = await POST(request({ previewMode: 'scene', characterName: 'Missing' }));
    expect(response.status).toBe(400);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
