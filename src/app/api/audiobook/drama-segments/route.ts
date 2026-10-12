import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookJobs, documents, documentSettings } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { getAudiobookObjectBuffer, isMissingBlobError } from '@/lib/server/audiobooks/blobstore';
import { dramaCastHash, dramaReviewRevision, dramaSpeakerReviewFileName, saveDramaSpeakerReview } from '@/lib/server/audiobooks/drama-speaker-review';
import { generateCloudDramaAudiobook } from '@/lib/server/audiobooks/cloud-drama';
import { normalizeGeminiTtsCharacterMap } from '@/lib/server/smart-audio/gemini-cast-helpers';
import { DramaDirectorValidationError, validateDramaDirectorOutput } from '@/lib/server/smart-audio/drama-director';
import type { DramaSpeakerReview } from '@/lib/shared/drama-speaker-review';
import { normalizeDramaSpeechSettings } from '@/lib/shared/drama-speech-settings';
import { normalizeDramaChapterTitleSettings } from '@/lib/shared/drama-chapter-titles';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { resolveDramaDirectorModel } from '@/lib/shared/smart-audio-models';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';

export const dynamic = 'force-dynamic';

// Serialize optimistic review updates within the serving process.
const reviewWrites = new Map<string, Promise<unknown>>();

async function serializeReviewWrite<T>(id: string, action: () => Promise<T>): Promise<T> {
  const pending = reviewWrites.get(id) ?? Promise.resolve();
  const write = pending.catch(() => {}).then(action);
  reviewWrites.set(id, write);
  try { return await write; } finally { if (reviewWrites.get(id) === write) reviewWrites.delete(id); }
}

async function savedRevision(scope: { bookId: string; userId: string; chapterIndex: number; namespace: string | null }): Promise<string | null> {
  try {
    const review = JSON.parse((await getAudiobookObjectBuffer(scope.bookId, scope.userId, dramaSpeakerReviewFileName(scope.chapterIndex), scope.namespace)).toString('utf8')) as DramaSpeakerReview;
    return dramaReviewRevision(review);
  } catch (error) { if (isMissingBlobError(error)) return null; throw error; }
}

async function isRecording(bookId: string, userId: string): Promise<boolean> {
  const rows = await db.select({ id: audiobookJobs.id }).from(audiobookJobs).where(and(
    eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, userId), inArray(audiobookJobs.status, ['queued', 'running']),
  )).limit(1);
  return rows.length > 0;
}

async function ownedChapter(request: NextRequest, bookId: unknown, chapterValue: unknown) {
  if (typeof bookId !== 'string' || !bookId || chapterValue === null || chapterValue === undefined || chapterValue === '') {
    return NextResponse.json({ error: 'Book and chapter are required.' }, { status: 400 });
  }
  const chapterIndex = Number(chapterValue);
  if (!Number.isSafeInteger(chapterIndex) || chapterIndex < 0) return NextResponse.json({ error: 'Invalid chapter index.' }, { status: 400 });
  const context = await requireAuthContext(request);
  if (context instanceof Response) return context;
  if (!context.userId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const [document] = await db.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.id, bookId), eq(documents.userId, context.userId))).limit(1);
  if (!document) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
  return { bookId, chapterIndex, userId: context.userId, namespace: getOpenReaderTestNamespace(request.headers) };
}

export async function GET(request: NextRequest) {
  try {
    const scope = await ownedChapter(request, request.nextUrl.searchParams.get('bookId'), request.nextUrl.searchParams.get('chapterIndex'));
    if (scope instanceof Response) return scope;
    try {
      const buffer = await getAudiobookObjectBuffer(scope.bookId, scope.userId, dramaSpeakerReviewFileName(scope.chapterIndex), scope.namespace);
      const review = JSON.parse(buffer.toString('utf8')) as DramaSpeakerReview;
      const [row] = await db.select({ dataJson: documentSettings.dataJson }).from(documentSettings)
        .where(and(eq(documentSettings.documentId, scope.bookId), eq(documentSettings.userId, scope.userId))).limit(1);
      const settings = typeof row?.dataJson === 'string' ? JSON.parse(row.dataJson) : row?.dataJson;
      const map = normalizeGeminiTtsCharacterMap(settings?.smartAudioCharacters);
      const profile = findSmartAudioProfileById(await readSmartAudioProfilesDocument(scope.userId), review.profileId);
      const chapterTitles = normalizeDramaChapterTitleSettings(review.chapterTitles ?? profile?.dramaGeminiTtsSettings?.chapterTitles);
      return NextResponse.json({ review: { ...review, revision: dramaReviewRevision(review), segments: review.segments.map(turn => turn.utteranceType === 'chapter-title'
        ? { ...turn, voiceId: chapterTitles.voiceId || map?.entries.Narrator?.voiceId || turn.voiceId } : turn) }, castNames: Object.keys(map?.entries ?? {}), chapterTitles,
        castVoices: Object.fromEntries(Object.entries(map?.entries ?? {}).map(([name, entry]) => [name, { voiceId: entry.voiceId, ttsModel: entry.ttsModel }])),
        speechTypes: normalizeDramaSpeechSettings(review.speechTypes ?? profile?.dramaGeminiTtsSettings?.speechTypes),
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      return NextResponse.json({ review: null }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
  } catch (error) {
    return errorResponse(error, { logger: serverLogger, event: 'audiobook.drama_review.load_failed', apiErrorMessage: 'Could not load speaker review.' });
  }
}

/** Correct classifications and choose sounds without changing source text or existing audio. */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const scope = await ownedChapter(request, body.bookId, body.chapterIndex);
    if (scope instanceof Response) return scope;
    const id = `${scope.namespace ?? ''}:${scope.userId}:${scope.bookId}:${scope.chapterIndex}`;
    return await serializeReviewWrite(id, async () => {
      if (await isRecording(scope.bookId, scope.userId)) return NextResponse.json({ error: 'Pause or finish recording before changing speaker turns.' }, { status: 409 });
      let review: DramaSpeakerReview;
      try { review = JSON.parse((await getAudiobookObjectBuffer(scope.bookId, scope.userId, dramaSpeakerReviewFileName(scope.chapterIndex), scope.namespace)).toString('utf8')); }
      catch (error) { if (!isMissingBlobError(error)) throw error; return NextResponse.json({ error: 'Prepare speaker review first.' }, { status: 404 }); }
      if (!review.complete || body.revision !== dramaReviewRevision(review)) return NextResponse.json({ error: 'Speaker review changed. Refresh before saving your corrections.' }, { status: 409 });
      const prefix = String(scope.chapterIndex + 1).padStart(4, '0');
      let text: string;
      try { text = (await getAudiobookObjectBuffer(scope.bookId, scope.userId, `${prefix}__text.txt`, scope.namespace)).toString('utf8'); }
      catch (error) { if (!isMissingBlobError(error)) throw error; text = (await getAudiobookObjectBuffer(scope.bookId, scope.userId, `${prefix}__rejected.txt`, scope.namespace)).toString('utf8'); }
      if (text !== review.sourceText) return NextResponse.json({ error: 'Chapter text changed. Prepare speaker review again.' }, { status: 409 });
      const [row] = await db.select({ dataJson: documentSettings.dataJson }).from(documentSettings)
        .where(and(eq(documentSettings.documentId, scope.bookId), eq(documentSettings.userId, scope.userId))).limit(1);
      const settings = typeof row?.dataJson === 'string' ? JSON.parse(row.dataJson) : row?.dataJson;
      const map = normalizeGeminiTtsCharacterMap(settings?.smartAudioCharacters);
      if (!map || review.castHash && review.castHash !== dramaCastHash(map)) return NextResponse.json({ error: 'The cast changed. Prepare speaker review again.' }, { status: 409 });
      if (!Array.isArray(body.turns) || body.turns.length !== review.segments.length) return NextResponse.json({ error: 'Every saved turn must be present, in order.' }, { status: 400 });
      const segments = validateDramaDirectorOutput({ sourceText: text, castNames: Object.keys(map.entries), output: review.segments.map((turn, index) => {
        const correction = body.turns[index];
        if (!correction || correction.index !== index) throw new Error('Turn order changed.');
        const { voiceId: _voice, ttsModel: _model, ...direction } = turn; void _voice; void _model;
        return { ...direction, speaker: correction.speaker, utteranceType: correction.utteranceType };
      }) });
      const current = JSON.parse((await getAudiobookObjectBuffer(scope.bookId, scope.userId, dramaSpeakerReviewFileName(scope.chapterIndex), scope.namespace)).toString('utf8')) as DramaSpeakerReview;
      if (dramaReviewRevision(current) !== body.revision || await isRecording(scope.bookId, scope.userId)) return NextResponse.json({ error: 'Recording or review changed while saving. Refresh and retry.' }, { status: 409 });
      const saved = await saveDramaSpeakerReview({ ...scope, sourceText: text, characterMap: map, profileId: review.profileId,
        segments, complete: true, preparedOnly: true, reviewedAt: Date.now(), speechTypes: normalizeDramaSpeechSettings(body.speechTypes),
        chapterTitles: body.chapterTitles === undefined ? review.chapterTitles : normalizeDramaChapterTitleSettings(body.chapterTitles) });
      return NextResponse.json({ review: saved }, { headers: { 'Cache-Control': 'private, no-store' } });
    });
  } catch (error) {
    if (error instanceof DramaDirectorValidationError) return NextResponse.json({ error: error.issues.slice(0, 3).join('; ') }, { status: 400 });
    return errorResponse(error, { logger: serverLogger, event: 'audiobook.drama_review.save_failed', apiErrorMessage: 'Could not save speaker review.' });
  }
}

/** Explicitly prepare old chapters using the Director; do not synthesize audio. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const scope = await ownedChapter(request, body.bookId, body.chapterIndex);
    if (scope instanceof Response) return scope;
    const profile = findSmartAudioProfileById(await readSmartAudioProfilesDocument(scope.userId), body.profileId);
    if (profile?.workerMode !== 'drama-gemini-tts' || !profile.geminiApiKey?.trim()) {
      return NextResponse.json({ error: 'Select a Gemini Drama profile with an API key.' }, { status: 400 });
    }
    const [row] = await db.select({ dataJson: documentSettings.dataJson }).from(documentSettings)
      .where(and(eq(documentSettings.documentId, scope.bookId), eq(documentSettings.userId, scope.userId))).limit(1);
    const settings = typeof row?.dataJson === 'string' ? JSON.parse(row.dataJson) : row?.dataJson;
    const map = normalizeGeminiTtsCharacterMap(settings?.smartAudioCharacters);
    if (!map) return NextResponse.json({ error: 'A saved Gemini Drama cast is required.' }, { status: 400 });
    if (await isRecording(scope.bookId, scope.userId)) return NextResponse.json({ error: 'Pause or finish recording before preparing speaker turns.' }, { status: 409 });
    let sourceText: string;
    const prefix = String(scope.chapterIndex + 1).padStart(4, '0');
    try {
      sourceText = (await getAudiobookObjectBuffer(scope.bookId, scope.userId, `${prefix}__text.txt`, scope.namespace)).toString('utf8');
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      try {
        sourceText = (await getAudiobookObjectBuffer(scope.bookId, scope.userId, `${prefix}__rejected.txt`, scope.namespace)).toString('utf8');
      } catch (rejectedError) {
        if (!isMissingBlobError(rejectedError)) throw rejectedError;
        return NextResponse.json({ error: 'No saved chapter text is available.' }, { status: 404 });
      }
    }
    if (!sourceText.trim() || sourceText.length > 500_000) return NextResponse.json({ error: 'Chapter text is empty or too large.' }, { status: 400 });
    const revision = await savedRevision(scope);
    const result = await generateCloudDramaAudiobook({
      cleanedText: sourceText, characterMap: map, geminiApiKey: profile.geminiApiKey,
      backupGeminiApiKey: profile.backupGeminiApiKey, directorModel: resolveDramaDirectorModel(profile),
      dramaGeminiTtsSettings: profile.dramaGeminiTtsSettings, signal: request.signal, directionOnly: true,
      chapterTitle: typeof body.chapterTitle === 'string' ? body.chapterTitle.slice(0, 500) : undefined,
    });
    const id = `${scope.namespace ?? ''}:${scope.userId}:${scope.bookId}:${scope.chapterIndex}`;
    return await serializeReviewWrite(id, async () => {
      if (await isRecording(scope.bookId, scope.userId) || await savedRevision(scope) !== revision) {
        return NextResponse.json({ error: 'Recording or saved turns changed while preparing. Reload and retry.' }, { status: 409 });
      }
      const [currentRow] = await db.select({ dataJson: documentSettings.dataJson }).from(documentSettings)
        .where(and(eq(documentSettings.documentId, scope.bookId), eq(documentSettings.userId, scope.userId))).limit(1);
      const currentSettings = typeof currentRow?.dataJson === 'string' ? JSON.parse(currentRow.dataJson) : currentRow?.dataJson;
      const currentMap = normalizeGeminiTtsCharacterMap(currentSettings?.smartAudioCharacters);
      let currentText: string;
      try { currentText = (await getAudiobookObjectBuffer(scope.bookId, scope.userId, `${prefix}__text.txt`, scope.namespace)).toString('utf8'); }
      catch (error) { if (!isMissingBlobError(error)) throw error; currentText = (await getAudiobookObjectBuffer(scope.bookId, scope.userId, `${prefix}__rejected.txt`, scope.namespace)).toString('utf8'); }
      if (!currentMap || dramaCastHash(currentMap) !== dramaCastHash(map) || currentText !== sourceText) {
        return NextResponse.json({ error: 'Chapter text or cast changed while preparing. Reload and retry.' }, { status: 409 });
      }
      const review = await saveDramaSpeakerReview({ ...scope, profileId: profile.id, sourceText,
        characterMap: map, segments: result.segments, complete: true, preparedOnly: true,
        speechTypes: normalizeDramaSpeechSettings(profile.dramaGeminiTtsSettings?.speechTypes),
        chapterTitles: normalizeDramaChapterTitleSettings(profile.dramaGeminiTtsSettings?.chapterTitles) });
      return NextResponse.json({ review }, { headers: { 'Cache-Control': 'private, no-store' } });
    });
  } catch (error) {
    if (error instanceof DramaDirectorValidationError) {
      return NextResponse.json({ error: 'The Director could not preserve this chapter exactly. Review its diagnostic and retry the chapter.' }, { status: 422 });
    }
    return errorResponse(error, { logger: serverLogger, event: 'audiobook.drama_review.prepare_failed', apiErrorMessage: 'Could not prepare speaker review. Check Gemini access and retry.' });
  }
}
