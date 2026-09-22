import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { isValidCloudTtsVoice } from '@/lib/shared/google-cloud-tts-voices';
import { synthesizeWithCloudTts } from '@/lib/server/smart-audio/google-cloud-tts-client';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const context = await requireAuthContext(request);
  if (context instanceof Response) return context;
  if (!context.userId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const documentId = typeof body.documentId === 'string' ? body.documentId.trim().toLowerCase() : '';
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
  const voiceName = typeof body.voiceName === 'string' ? body.voiceName.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : '';
  const audioProfile = typeof body.audioProfile === 'string' ? body.audioProfile.trim().slice(0, 1_000) : '';
  if (!documentId || !profileId || !text || !isValidCloudTtsVoice(voiceName)) {
    return NextResponse.json({ error: 'A valid document, profile, voice, and sample text are required.' }, { status: 400 });
  }
  const [document] = await db.select({ id: documents.id }).from(documents).where(and(
    eq(documents.id, documentId), eq(documents.userId, context.userId),
  )).limit(1);
  if (!document) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
  const profiles = await readSmartAudioProfilesDocument(context.userId);
  const profile = findSmartAudioProfileById(profiles, profileId);
  if (profile?.workerMode !== 'drama-gemini-tts') {
    return NextResponse.json({ error: 'A Google Cloud Drama profile is required.' }, { status: 400 });
  }
  try {
    const result = await synthesizeWithCloudTts({
      text, voiceName,
      stylePrompt: audioProfile || 'Speak naturally as this audiobook character.',
      serviceAccountJson: profile.googleCloudServiceAccountJson,
    });
    return new NextResponse(new Uint8Array(result.audioBuffer), {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'Google Cloud voice preview failed. Check the profile credential and Cloud permissions.' }, { status: 502 });
  }
}
