import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documents, documentSettings } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { getAudiobookObjectBuffer, isMissingBlobError } from '@/lib/server/audiobooks/blobstore';
import { dramaSpeakerReviewFileName, saveDramaSpeakerReview } from '@/lib/server/audiobooks/drama-speaker-review';
import { generateCloudDramaAudiobook } from '@/lib/server/audiobooks/cloud-drama';
import { normalizeGeminiTtsCharacterMap } from '@/lib/server/smart-audio/gemini-cast-helpers';
import { DramaDirectorValidationError } from '@/lib/server/smart-audio/drama-director';
import { findSmartAudioProfileById, readSmartAudioProfilesDocument } from '@/lib/server/smart-audio-profiles';
import { resolveDramaDirectorModel } from '@/lib/shared/smart-audio-models';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';

export const dynamic = 'force-dynamic';

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
      return NextResponse.json({ review: JSON.parse(buffer.toString('utf8')) }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      return NextResponse.json({ review: null }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
  } catch (error) {
    return errorResponse(error, { logger: serverLogger, event: 'audiobook.drama_review.load_failed', apiErrorMessage: 'Could not load speaker review.' });
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
    const result = await generateCloudDramaAudiobook({
      cleanedText: sourceText, characterMap: map, geminiApiKey: profile.geminiApiKey,
      backupGeminiApiKey: profile.backupGeminiApiKey, directorModel: resolveDramaDirectorModel(profile),
      dramaGeminiTtsSettings: profile.dramaGeminiTtsSettings, signal: request.signal, directionOnly: true,
    });
    const review = await saveDramaSpeakerReview({ ...scope, profileId: profile.id, sourceText,
      characterMap: map, segments: result.segments, complete: true, preparedOnly: true });
    return NextResponse.json({ review }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof DramaDirectorValidationError) {
      return NextResponse.json({ error: 'The Director could not preserve this chapter exactly. Review its diagnostic and retry the chapter.' }, { status: 422 });
    }
    return errorResponse(error, { logger: serverLogger, event: 'audiobook.drama_review.prepare_failed', apiErrorMessage: 'Could not prepare speaker review. Check Gemini access and retry.' });
  }
}
