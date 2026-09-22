import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { synthesizeWithCloudTts, CloudTtsApiError } from '@/lib/server/smart-audio/google-cloud-tts-client';
import { CLOUD_TTS_CHARACTER_VOICE_SET } from '@/lib/shared/google-cloud-tts-voices';
import { normalizeDramaGeminiTtsProfileSettings } from '@/lib/shared/drama-profile-settings';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const context = await requireAuthContext(request);
  if (context instanceof Response) return context;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
  if (!profileId) return NextResponse.json({ error: 'A Smart Audio profile is required.' }, { status: 400 });
  const profile = findSmartAudioProfileById(await readSmartAudioProfilesDocument(context.userId), profileId);
  if (!profile || profile.workerMode !== 'drama-gemini-tts') {
    return NextResponse.json({ error: 'A Google Cloud Drama profile is required.' }, { status: 400 });
  }
  try {
    const settings = normalizeDramaGeminiTtsProfileSettings(profile.dramaGeminiTtsSettings);
    await synthesizeWithCloudTts({
      text: 'This is a Narratum Google Cloud connection test.',
      stylePrompt: 'Speak naturally and clearly as a short connection test.',
      voiceName: [...CLOUD_TTS_CHARACTER_VOICE_SET][0],
      languageCode: settings.languageCode,
      serviceAccountJson: profile.googleCloudServiceAccountJson,
    });
    return NextResponse.json({ success: true, message: 'Google Cloud connection successful.' });
  } catch (error) {
    if (error instanceof CloudTtsApiError && (error.statusCode === 401 || error.statusCode === 403)) {
      return NextResponse.json({ error: 'Authentication succeeded, but Gemini-TTS access was denied. Verify the required Google Cloud permissions.' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Authentication failed. Verify the service-account JSON, project configuration, and Cloud permissions.' }, { status: 502 });
  }
}

