import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getAudiobookObjectBuffer, isMissingBlobError } from '@/lib/server/audiobooks/blobstore';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const bookId = request.nextUrl.searchParams.get('bookId');
  const chapterIndex = Number(request.nextUrl.searchParams.get('chapterIndex'));
  const kind = request.nextUrl.searchParams.get('kind') || 'director';
  if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0) {
    return NextResponse.json({ error: 'bookId and a valid chapterIndex are required' }, { status: 400 });
  }
  const ctxOrRes = await requireAuthContext(request);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const owned = await db.select({ id: audiobooks.id }).from(audiobooks)
    .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, ctxOrRes.userId)));
  if (!owned.length) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  if (kind !== 'director' && kind !== 'provider') return NextResponse.json({ error: 'Invalid diagnostic kind' }, { status: 400 });
  const fileName = kind === 'provider'
    ? `${String(chapterIndex + 1).padStart(4, '0')}__provider_failure.json`
    : `drama-director-failure-chapter-${String(chapterIndex).padStart(4, '0')}.json`;
  try {
    const body = await getAudiobookObjectBuffer(bookId, ctxOrRes.userId, fileName, null);
    return new NextResponse(body as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (isMissingBlobError(error)) return NextResponse.json({ error: 'No saved Gemini Director response for this chapter' }, { status: 404 });
    throw error;
  }
}
