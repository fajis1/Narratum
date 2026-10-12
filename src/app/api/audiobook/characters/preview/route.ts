import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { documentSettings, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { resolveGeminiPrebuiltVoiceCatalog } from '@/lib/server/smart-audio/gemini-voice-catalog-cache';
import { normalizeGeminiTtsCharacterMap } from '@/lib/server/smart-audio/gemini-cast-helpers';
import { synthesizeWithGeminiTts, GEMINI_TTS_AUDIO_MIME_TYPE, GEMINI_TTS_MODEL, isGeminiTtsModel } from '@/lib/server/smart-audio/gemini-tts-client';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { getStoredGeminiVoicePreview, putStoredGeminiVoicePreview } from '@/lib/server/smart-audio/gemini-voice-preview-cache';
import { applyDramaAudioEffect } from '@/lib/server/audiobooks/drama-audio-effects';
import { DRAMA_UTTERANCE_TYPES } from '@/lib/shared/drama-director-schema';
import { normalizeDramaSpeechSettings } from '@/lib/shared/drama-speech-settings';
import { normalizeDramaChapterTitleSettings } from '@/lib/shared/drama-chapter-titles';
import { buildDramaDirectorPolicy } from '@/lib/shared/drama-profile-settings';
import { validateDramaDirectorOutput, DramaDirectorValidationError } from '@/lib/server/smart-audio/drama-director';
import { buildGeminiDramaTtsRequest, resolveGeminiCastEntry } from '@/lib/server/smart-audio/drama-cloud-request';
import { synthesizeGeminiDramaSegment } from '@/lib/server/smart-audio/drama-cloud-synthesis';
import { GeminiDramaQuotaTracker } from '@/lib/server/smart-audio/gemini-drama-quota';
import {
  GEMINI_VOICE_ONLY_PREVIEW_CACHE_VERSION,
  GEMINI_VOICE_ONLY_PREVIEW_STYLE,
  GEMINI_VOICE_ONLY_PREVIEW_TEXT,
} from '@/lib/shared/gemini-voice-preview';

export const dynamic = 'force-dynamic';
const PREVIEW_TTL_MS = 30 * 60 * 1_000;
const MAX_PREVIEW_CACHE_ENTRIES = 80;
const previewCache = new Map<string, { expiresAt: number; audio: Buffer }>();
const previewQuota = new GeminiDramaQuotaTracker();

function previewStyle(input: { mode: 'voice-only' | 'character' | 'scene'; description: string; sceneContext: string }): string {
  if (input.mode === 'voice-only') return GEMINI_VOICE_ONLY_PREVIEW_STYLE;
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
  const requestedText = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : '';
  const previewMode = body.previewMode === 'voice-only' || body.previewMode === 'scene' ? body.previewMode : 'character';
  const text = previewMode === 'voice-only' ? GEMINI_VOICE_ONLY_PREVIEW_TEXT : requestedText;
  const characterName = typeof body.characterName === 'string' ? body.characterName.trim() : '';
  const sceneContext = typeof body.sceneContext === 'string' ? body.sceneContext.trim().slice(0, 500) : '';
  if (!documentId || !profileId || !voiceName || (previewMode !== 'voice-only' && !text)) {
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
    const catalogVoice = catalog.voices.find((voice) => voice.id === voiceName);
    if (!catalogVoice) {
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
    const classifiedScene = previewMode === 'scene' && body.utteranceType !== undefined;
    const resolvedEntry = classifiedScene && characterMap ? resolveGeminiCastEntry(characterMap, characterName) : entry;
    const requestedModel = typeof body.modelName === 'string' && isGeminiTtsModel(body.modelName)
      ? body.modelName
      : undefined;
    const voiceModel = classifiedScene ? (resolvedEntry?.ttsModel && isGeminiTtsModel(resolvedEntry.ttsModel) ? resolvedEntry.ttsModel : GEMINI_TTS_MODEL) : requestedModel
      ?? (entry?.ttsModel && isGeminiTtsModel(entry.ttsModel) ? entry.ttsModel : undefined)
      ?? (catalogVoice.model && isGeminiTtsModel(catalogVoice.model) ? catalogVoice.model : undefined)
      ?? GEMINI_TTS_MODEL;
    const speechTypes = normalizeDramaSpeechSettings(body.speechTypes ?? profile.dramaGeminiTtsSettings?.speechTypes);
    if (classifiedScene && !DRAMA_UTTERANCE_TYPES.includes(body.utteranceType as typeof DRAMA_UTTERANCE_TYPES[number])) {
      return NextResponse.json({ error: 'Select a valid speech type.' }, { status: 400 });
    }
    const segment = classifiedScene ? validateDramaDirectorOutput({ sourceText: text, castNames: Object.keys(characterMap!.entries), output: [{
      speaker: characterName, text, utteranceType: body.utteranceType, sceneContext: sceneContext || 'Preview this speaking turn.', omit_from_audio: false,
      performance: body.performance ?? { primaryEmotion: 'neutral', secondaryEmotions: [], socialIntent: 'none', delivery: ['natural'], pace: 'normal', energy: 'normal', intensity: 'medium', tags: [] },
    }] })[0] : null;
    const policy = buildDramaDirectorPolicy({ ...profile.dramaGeminiTtsSettings, speechTypes,
      chapterTitles: normalizeDramaChapterTitleSettings(body.chapterTitles ?? profile.dramaGeminiTtsSettings?.chapterTitles) });
    const built = segment ? buildGeminiDramaTtsRequest({ segment, characterMap: characterMap!, policy, modelName: voiceModel }) : null;
    const style = built?.style ?? previewStyle({ mode: previewMode, description: entry?.cloudDirection?.audioProfile || entry?.description || '', sceneContext });
    const respond = async (audio: Buffer, hit: string, maxAge = 1800) => {
      const treated = segment ? await applyDramaAudioEffect(audio, speechTypes[segment.utteranceType], request.signal) : audio;
      return new NextResponse(new Uint8Array(treated), { headers: { 'Content-Type': GEMINI_TTS_AUDIO_MIME_TYPE,
        'Cache-Control': `private, max-age=${maxAge}`, 'X-Narratum-Preview-Cache': hit } });
    };
    const key = previewMode === 'voice-only'
      ? cacheKey({ kind: 'gemini-voice-only', version: GEMINI_VOICE_ONLY_PREVIEW_CACHE_VERSION, voiceName, model: voiceModel })
      : cacheKey({ userId: context.userId, documentId, profileId, voiceName: built?.voiceName ?? voiceName, text, previewMode, characterName, sceneContext, model: voiceModel, style });
    const cached = readCachedPreview(key);
    if (cached) return await respond(cached, 'HIT');
    if (previewMode === 'voice-only') {
      const stored = await getStoredGeminiVoicePreview(key).catch((storageError) => {
        serverLogger.warn({ event: 'audiobook.gemini_drama.preview.cache_read_failed', error: errorToLog(storageError), voiceName }, 'Could not read the stored Gemini voice preview.');
        return null;
      });
      if (stored) {
        writeCachedPreview(key, stored);
        return new NextResponse(new Uint8Array(stored), { headers: { 'Content-Type': GEMINI_TTS_AUDIO_MIME_TYPE, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Narratum-Preview-Cache': 'PERSISTENT_HIT' } });
      }
    }

    const sceneResult = segment ? await synthesizeGeminiDramaSegment({ segment, characterMap: characterMap!, apiKey,
      backupApiKey: profile.backupGeminiApiKey, quotaTracker: previewQuota, policy, modelName: voiceModel,
      signal: request.signal, deferProviderFailures: true,
    }) : null;
    const result = sceneResult ? { audioBuffer: sceneResult.chunks[0].audioBuffer!, mimeType: GEMINI_TTS_AUDIO_MIME_TYPE } : await synthesizeWithGeminiTts({
      text, voiceName, apiKey,
      style, signal: request.signal,
      ...(previewMode === 'voice-only' || voiceModel !== GEMINI_TTS_MODEL ? { modelName: voiceModel } : {}),
    });
    writeCachedPreview(key, result.audioBuffer);
    if (previewMode === 'voice-only') {
      await putStoredGeminiVoicePreview(key, result.audioBuffer, result.mimeType).catch((storageError) => {
        serverLogger.warn({ event: 'audiobook.gemini_drama.preview.cache_write_failed', error: errorToLog(storageError), voiceName }, 'Could not store the Gemini voice preview.');
      });
    }
    return await respond(result.audioBuffer, 'MISS');
  } catch (error) {
    if (error instanceof DramaDirectorValidationError) return NextResponse.json({ error: 'The preview has invalid speech direction.' }, { status: 400 });
    serverLogger.error({ event: 'audiobook.gemini_drama.preview.failed', error: errorToLog(error), documentId, profileId, voiceName }, 'Gemini voice preview failed.');
    return NextResponse.json({ error: 'Gemini voice preview failed. Check the profile API key and Gemini access.' }, { status: 502 });
  }
}
