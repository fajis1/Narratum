import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documentSettings, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { isValidCloudTtsVoice } from '@/lib/shared/google-cloud-tts-voices';
import { synthesizeWithCloudTts } from '@/lib/server/smart-audio/google-cloud-tts-client';
import { normalizeCloudTtsCharacterMap } from '@/lib/server/smart-audio/google-cloud-cast-helpers';
import { buildDramaDirectorsBrief } from '@/lib/server/smart-audio/drama-cloud-request';
import { buildDramaDirectorPolicy, normalizeDramaGeminiTtsProfileSettings } from '@/lib/shared/drama-profile-settings';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import type { DramaCharacterDirection } from '@/types/document-settings';

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
  const previewMode = body.previewMode === 'voice-only' || body.previewMode === 'scene' ? body.previewMode : 'character';
  const characterName = typeof body.characterName === 'string' ? body.characterName.trim() : '';
  const sceneContext = typeof body.sceneContext === 'string' ? body.sceneContext.trim().slice(0, 500) : '';
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
    const settingsRows = await db.select({ dataJson: documentSettings.dataJson }).from(documentSettings).where(and(
      eq(documentSettings.documentId, documentId), eq(documentSettings.userId, context.userId),
    )).limit(1);
    const rawSettings = typeof settingsRows[0]?.dataJson === 'string'
      ? JSON.parse(settingsRows[0].dataJson)
      : settingsRows[0]?.dataJson;
    const characterMap = normalizeCloudTtsCharacterMap(rawSettings && typeof rawSettings === 'object'
      ? (rawSettings as Record<string, unknown>).smartAudioCharacters
      : null);
    const entry = characterName && characterMap?.entries[characterName]
      ? characterMap.entries[characterName]
      : null;
    if (previewMode !== 'voice-only' && !entry) {
      return NextResponse.json({ error: 'Select a saved character before using this preview mode.' }, { status: 400 });
    }
    const settings = normalizeDramaGeminiTtsProfileSettings(profile.dramaGeminiTtsSettings);
    const policy = buildDramaDirectorPolicy(settings);
    const stylePrompt = previewMode === 'voice-only'
      ? 'Speak naturally and clearly as a neutral audiobook voice comparison.'
      : buildDramaDirectorsBrief({
        speaker: entry!.name,
        utteranceType: 'spoken-dialogue',
        text,
        sceneContext: previewMode === 'scene' ? (sceneContext || 'A short dramatic audiobook scene.') : 'A neutral character baseline preview.',
        omit_from_audio: false,
        performance: {
          primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'none', delivery: ['natural'],
          pace: 'normal', energy: 'normal', intensity: 'controlled', tags: [],
        },
      }, entry!, policy);
    const result = await synthesizeWithCloudTts({
      text, voiceName,
      stylePrompt,
      languageCode: settings.languageCode,
      serviceAccountJson: profile.googleCloudServiceAccountJson,
    });
    return new NextResponse(new Uint8Array(result.audioBuffer), {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    serverLogger.error({
      event: 'audiobook.cloud_drama.preview.failed',
      error: errorToLog(error),
      documentId,
      profileId,
      voiceName,
    }, 'Google Cloud voice preview failed.');
    const message = error instanceof Error ? error.message : 'Google Cloud voice preview failed.';
    return NextResponse.json({
      error: `Google Cloud voice preview failed: ${message}. Check the profile credential and Cloud permissions.`,
    }, { status: 502 });
  }
}
