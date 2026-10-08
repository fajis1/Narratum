import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documents, audiobooks, audiobookJobs } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { collectTroubleshootingArtifacts, sanitizeTroubleshooting } from '@/lib/server/audiobooks/troubleshooting';
import { GET as getFailureLog } from '../failure-log/route';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const bookId = request.nextUrl.searchParams.get('bookId');
  if (!bookId || !/^[a-zA-Z0-9._-]{1,128}$/.test(bookId)) return NextResponse.json({ error: 'Valid bookId required' }, { status: 400 });
  const ctx = await requireAuthContext(request);
  if (ctx instanceof Response) return ctx;
  if (!ctx.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [document] = await db.select({ title: documents.name }).from(documents)
    .where(and(eq(documents.id, bookId), eq(documents.userId, ctx.userId))).limit(1);
  const [book] = await db.select({ title: audiobooks.title }).from(audiobooks)
    .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, ctx.userId))).limit(1);
  if (!document && !book) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
  const namespace = getOpenReaderTestNamespace(request.headers);
  const { artifacts, unavailable } = await collectTroubleshootingArtifacts(bookId, ctx.userId, namespace);
  const jobs = await db.select({ id: audiobookJobs.id, status: audiobookJobs.status,
    error: audiobookJobs.error, createdAt: audiobookJobs.createdAt }).from(audiobookJobs)
    .where(and(eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, ctx.userId)))
    .orderBy(desc(audiobookJobs.createdAt)).limit(20);
  // Always include every chapter, regardless of the modal's selected chapter.
  const summaryUrl = new URL(request.url);
  summaryUrl.searchParams.delete('chapterIndex');
  const summaryResponse = await getFailureLog(new NextRequest(summaryUrl, { headers: request.headers }));
  const summary = summaryResponse.ok ? await summaryResponse.json() : { unavailable: true };
  const body = sanitizeTroubleshooting({ schemaVersion: 1, exportedAt: new Date().toISOString(),
    bookId, bookTitle: book?.title ?? document?.title, jobs, summary, artifacts, unavailable,
    notes: [
      'Snapshot taken during download; generation may still be running.',
      'Manuscript text and character directions are included. Credentials and binary audio are excluded.',
      'Artifacts may belong to earlier jobs; compare their jobId and timestamps with the jobs list.',
      'TTS attempt capture is available only for generation performed after this feature was installed.',
      'Successful Director output is represented by validated speaker snapshots; raw successful Director envelopes are not retained.',
      'TTS attempts are retained separately for each chapter generation run, with up to 2000 provider requests per run.',
      'Deleting the book also removes its diagnostics. Save this bundle before deleting it.',
    ] });
  return new NextResponse(JSON.stringify(body, null, 2), { headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="narratum-troubleshooting-${bookId}.json"`,
    'Cache-Control': 'private, no-store',
  } });
}
