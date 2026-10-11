import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { readAudiobookCompleteness } from '@/lib/server/audiobooks/completeness';
import { EMPTY_FINAL_CHAPTER_RECEIPT } from '@/lib/server/audiobooks/empty-final-chapter';
import { putAudiobookObject } from '@/lib/server/audiobooks/blobstore';
import { errorResponse } from '@/lib/server/errors/next-response';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthContext(request);
    if (auth instanceof Response) return auth;
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    if (typeof body?.bookId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(body.bookId)
        || !Number.isSafeInteger(body.chapterIndex) || body.chapterIndex < 0
        || typeof body.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/u.test(body.snapshotHash)
        || body.confirmOmit !== true) {
      return NextResponse.json({ error: 'Confirm the empty final chapter before omitting it.' }, { status: 400 });
    }
    const [book] = await db.select({ id: audiobooks.id }).from(audiobooks)
      .where(and(eq(audiobooks.id, body.bookId), eq(audiobooks.userId, auth.userId))).limit(1);
    if (!book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    const namespace = getOpenReaderTestNamespace(request.headers);
    const state = await readAudiobookCompleteness(body.bookId, auth.userId, namespace);
    const candidate = state.emptyFinalChapterOmissionCandidate;
    if (!candidate || candidate.chapterIndex !== body.chapterIndex || candidate.snapshotHash !== body.snapshotHash) {
      return NextResponse.json({ error: 'The chapter or generation state changed. Refresh the book. Only an unrecorded final chapter with no saved content can be omitted; pause active generation first.' }, { status: 409 });
    }
    const receipt = { schemaVersion: 1, reason: 'user_confirmed_empty_final_chapter', ...candidate,
      confirmedBy: auth.userId, confirmedAt: Date.now() };
    await putAudiobookObject(body.bookId, auth.userId, EMPTY_FINAL_CHAPTER_RECEIPT, Buffer.from(JSON.stringify(receipt)), 'application/json', namespace);
    const current = await readAudiobookCompleteness(body.bookId, auth.userId, namespace);
    if (!current.omittedChapterIndexes.includes(candidate.chapterIndex)) {
      return NextResponse.json({ error: 'The source changed during confirmation. The chapter remains required; refresh and review it.' }, { status: 409 });
    }
    return NextResponse.json({ success: true, omittedChapterIndex: candidate.chapterIndex, complete: current.complete });
  } catch (error) {
    return errorResponse(error, { apiErrorMessage: 'Could not omit the empty final chapter.' });
  }
}
