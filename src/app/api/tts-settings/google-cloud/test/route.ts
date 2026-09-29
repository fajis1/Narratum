import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { synthesizeWithGeminiTts, GeminiTtsApiError } from '@/lib/server/smart-audio/gemini-tts-client';
import { CLOUD_TTS_CHARACTER_VOICE_SET } from '@/lib/shared/google-cloud-tts-voices';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const context = await requireAuthContext(request);
  if (context instanceof Response) return context;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
  if (!profileId) return NextResponse.json({ error: 'A Smart Audio profile is required.' }, { status: 400 });
  const profile = findSmartAudioProfileById(await readSmartAudioProfilesDocument(context.userId), profileId);
  if (!profile || profile.workerMode !== 'drama-gemini-tts') {
    return NextResponse.json({ error: 'A Gemini Audio Drama profile is required.' }, { status: 400 });
  }
  if (!profile.geminiApiKey?.trim()) {
    return NextResponse.json({ error: 'A Gemini API key is required.' }, { status: 400 });
  }
  try {
    await synthesizeWithGeminiTts({
      text: 'This is a Narratum Gemini connection test.',
      style: 'natural, clear, short connection test',
      voiceName: [...CLOUD_TTS_CHARACTER_VOICE_SET][0],
      apiKey: profile.geminiApiKey,
    });
    return NextResponse.json({ success: true, message: 'Gemini 3.8 TTS connection successful.' });
  } catch (error) {
    if (error instanceof GeminiTtsApiError && (error.statusCode === 401 || error.statusCode === 403)) {
      return NextResponse.json({ error: 'Gemini authentication succeeded, but TTS access was denied. Verify API-key access and billing.' }, { status: 403 });
    }
    return NextResponse.json({ error: 'Gemini 3.8 TTS connection failed. Verify the Gemini API key and billing.' }, { status: 502 });
  }
}
