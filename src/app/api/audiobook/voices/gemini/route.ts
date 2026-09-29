import { NextRequest, NextResponse } from 'next/server';

import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import {
  findSmartAudioProfileById,
  readSmartAudioProfilesDocument,
} from '@/lib/server/smart-audio-profiles';
import { resolveGeminiPrebuiltVoiceCatalog } from '@/lib/server/smart-audio/gemini-voice-catalog-cache';
import { DRAMA_GEMINI_TTS_WORKER_MODE } from '@/lib/shared/multi-voice';

export const dynamic = 'force-dynamic';

/** Returns only public Gemini voice metadata; credentials never leave the server. */
export async function GET(request: NextRequest) {
  try {
    const context = await requireAuthContext(request);
    if (context instanceof Response) return context;
    if (!context.userId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    const profileId = (new URL(request.url).searchParams.get('profileId') || '').trim();
    if (!profileId) return NextResponse.json({ error: 'Profile ID is required.' }, { status: 400 });

    const profile = findSmartAudioProfileById(await readSmartAudioProfilesDocument(context.userId), profileId);
    if (!profile) return NextResponse.json({ error: 'Smart Audio profile not found.' }, { status: 404 });
    if (profile.workerMode !== DRAMA_GEMINI_TTS_WORKER_MODE) {
      return NextResponse.json({ error: 'The selected profile is not a Gemini Audio Drama profile.' }, { status: 400 });
    }
    const apiKey = (profile.geminiApiKey || '').trim();
    if (!apiKey) return NextResponse.json({ error: 'The selected profile needs a Gemini API key.' }, { status: 400 });

    const catalog = await resolveGeminiPrebuiltVoiceCatalog({ apiKey });
    return NextResponse.json({
      provider: 'gemini',
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      catalogVersion: catalog.catalogVersion,
      voices: catalog.voices,
      ...(catalog.statusNotice ? { statusNotice: catalog.statusNotice } : {}),
    });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'audiobook.gemini_voice_library.load_failed',
      apiErrorMessage: 'Failed to load the Gemini voice library.',
    });
  }
}