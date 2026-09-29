import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { documentSettings, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { resolveGeminiPrebuiltVoiceCatalog } from '@/lib/server/smart-audio/gemini-voice-catalog-cache';
import { normalizeGeminiTtsCharacterMap } from '@/lib/server/smart-audio/gemini-cast-helpers';
import { synthesizeWithGeminiTts, GEMINI_TTS_AUDIO_MIME_TYPE } from '@/lib/server/smart-audio/gemini-tts-client';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';
const PREVIEW_TTL_MS = 30 * 60 * 1_000;
const MAX_PREVIEW_CACHE_ENTRIES = 80;
const previewCache = new Map<string, { expiresAt: number; audio: Buffer }>();

function previewStyle(input: { mode: 'voice-only' | 'character' | 'scene'; description: string; sceneContext: string }): string {
  if (input.mode === 'voice-only') return 'Speak naturally, clearly, and warmly for an audiobook voice comparison.';
  const parts = [input.description || 'Use the selected voice naturally and consistently.'];
  if (input.mode === 'scene') parts.push(`Scene context: ${input.sceneContext || 'A short dramatic audiobook scene.'}`);
  parts.push('Deliver this as a concise audiobook performance. Speak the supplied text faithfully.');
  return parts.join(' ').slice(0, 560);
}

function cacheKey(input: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function readCachedPreview(key: string): Buffer | null {
  const cached = previewCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) { previewCache.delete(key); return null; }
  return cached.audio;
}

function writeCachedPreview(key: string, audio: Buffer): void {
  if (previewCache.size >= MAX_PREVIEW_CACHE_ENTRIES) {
    const oldest = previewCache.keys().next().value;
    if (oldest) previewCache.delete(oldest);
  }
  previewCache.set(key, { expiresAt: Date.now() + PREVIEW_TTL_MS, audio });
}

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
  if (!documentId || !profileId || !voiceName || !text) {
    return NextResponse.json({ error: 'A valid document, profile, voice, and sample text are required.' }, { status: 400 });
  }
  const [document] = await db.select({ id: documents.id }).from(documents).where(and(
    eq(documents.id, documentId), eq(documents.userId, context.userId),
  )).limit(1);
  if (!document) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
  const profile = findSmartAudioProfileById(await readSmartAudioProfilesDocument(context.userId), profileId);
  if (profile?.workerMode !== 'drama-gemini-tts') {
    return NextResponse.json({ error: 'A Gemini Drama profile is required.' }, { status: 400 });
  }
  const apiKey = (profile.geminiApiKey || '').trim();
  if (!apiKey) return NextResponse.json({ error: 'The selected profile needs a Gemini API key.' }, { status: 400 });

  try {
    const catalog = await resolveGeminiPrebuiltVoiceCatalog({ apiKey });
    if (!catalog.voices.some((voice) => voice.id === voiceName)) {
      return NextResponse.json({ error: 'That voice is no longer available in the Gemini Voice Library.' }, { status: 400 });
    }
    const settingsRows = await db.select({ dataJson: documentSettings.dataJson }).from(documentSettings).where(and(
      eq(documentSettings.documentId, documentId), eq(documentSettings.userId, context.userId),
    )).limit(1);
    const rawSettings = typeof settingsRows[0]?.dataJson === 'string' ? JSON.parse(settingsRows[0].dataJson) : settingsRows[0]?.dataJson;
    const characterMap = normalizeGeminiTtsCharacterMap(rawSettings && typeof rawSettings === 'object'
      ? (rawSettings as Record<string, unknown>).smartAudioCharacters : null);
    const entry = characterName && characterMap?.entries[characterName] ? characterMap.entries[characterName] : null;
    if (previewMode !== 'voice-only' && !entry) {
      return NextResponse.json({ error: 'Select a saved character before using this preview mode.' }, { status: 400 });
    }
    const key = cacheKey({ userId: context.userId, documentId, profileId, voiceName, text, previewMode, characterName, sceneContext });
    const cached = readCachedPreview(key);
    if (cached) return new NextResponse(new Uint8Array(cached), { headers: { 'Content-Type': GEMINI_TTS_AUDIO_MIME_TYPE, 'Cache-Control': 'private, max-age=1800', 'X-Narratum-Preview-Cache': 'HIT' } });

    const result = await synthesizeWithGeminiTts({
      text, voiceName, apiKey,
      style: previewStyle({ mode: previewMode, description: entry?.cloudDirection?.audioProfile || entry?.description || '', sceneContext }),
    });
    writeCachedPreview(key, result.audioBuffer);
    return new NextResponse(new Uint8Array(result.audioBuffer), { headers: { 'Content-Type': result.mimeType, 'Cache-Control': 'private, max-age=1800', 'X-Narratum-Preview-Cache': 'MISS' } });
  } catch (error) {
    serverLogger.error({ event: 'audiobook.gemini_drama.preview.failed', error: errorToLog(error), documentId, profileId, voiceName }, 'Gemini voice preview failed.');
    const message = error instanceof Error ? error.message : 'Gemini voice preview failed.';
    return NextResponse.json({ error: `Gemini voice preview failed: ${message}. Check the profile API key and Gemini access.` }, { status: 502 });
  }
}