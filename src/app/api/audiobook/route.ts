import { readAudiobookCompleteness } from '@/lib/server/audiobooks/completeness';
import { NextRequest, NextResponse } from 'next/server';
export const maxDuration = 300; // 5 minutes max duration for large audiobook generation
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import { Readable } from 'stream';
import { db } from '@/db';
import { audiobooks, audiobookChapters, audiobookJobs } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  audiobookPrefix,
  deleteAudiobookObject,
  deleteAudiobookPrefix,
  getAudiobookObjectBuffer,
  getAudiobookObjectStream,
  getAudiobookRobustStreamWithMetadata,
  listAudiobookObjects,
  putAudiobookObject,
} from '@/lib/server/audiobooks/blobstore';
import {
  decodeChapterFileName,
  escapeFFMetadata,
  ffprobeAudio,
  listChapterObjects,
} from '@/lib/server/audiobooks/chapters';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { INTERNAL_WORKER_SECRET } from '@/lib/server/internal-secret';
import { getFFmpegPath } from '@/lib/server/audiobooks/ffmpeg-bin';
import type { TTSAudiobookFormat } from '@/types/tts';

export const dynamic = 'force-dynamic';

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

function isSafeId(value: string): boolean {
  return SAFE_ID_REGEX.test(value);
}

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Audiobooks storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function contentDispositionAttachment(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function chapterFileMimeType(format: TTSAudiobookFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
}

function streamBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}





export async function GET(request: NextRequest) {
  let workDir: string | null = null;
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    const requestedFormat = request.nextUrl.searchParams.get('format') as TTSAudiobookFormat | null;
    if (!bookId) {
      return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
    }
    if (!isSafeId(bookId)) {
      return NextResponse.json({ error: 'Invalid bookId parameter' }, { status: 400 });
    }

    const internalSecret = request.headers.get('x-internal-secret');
    let storageUserId: string;

    if (internalSecret === INTERNAL_WORKER_SECRET) {
      storageUserId = request.nextUrl.searchParams.get('userId') || '';
      if (!storageUserId) return NextResponse.json({ error: 'Missing userId parameter' }, { status: 400 });
    } else {
      const ctxOrRes = await requireAuthContext(request);
      if (ctxOrRes instanceof Response) return ctxOrRes;
      if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      storageUserId = ctxOrRes.userId;
    }

    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const existingBookRows = await db
      .select({ userId: audiobooks.userId, title: audiobooks.title })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));
    if (existingBookRows.length === 0) {
      console.log('DEBUG 404: Book not found', { bookId, storageUserId });
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const objectNames = objects.map((item) => item.fileName);
    const completeness = await readAudiobookCompleteness(bookId, storageUserId, testNamespace, objectNames);
    if (!completeness.complete) return NextResponse.json({ error: completeness.invalidOmissionChapterIndexes.length
      ? 'Some saved chapter omissions no longer match the pinned source. Retry or review those chapters before full-book export.'
      : 'Audiobook is incomplete. Retry missing chapters before full-book export.',
    code: completeness.activeReviewChapterIndexes.length ? 'AUDIOBOOK_CHAPTER_REVIEW_REQUIRED' : 'AUDIOBOOK_INCOMPLETE',
    missingChapterIndexes: completeness.missingChapterIndexes, invalidOmissionChapterIndexes: completeness.invalidOmissionChapterIndexes }, { status: 409 });
    const failedChapterFiles = objectNames.filter((name) => /^\d{1,6}__rejected\.txt$/u.test(name)
      && !completeness.recordedChapterIndexes.includes(Number(name.split('__')[0]) - 1));
    if (failedChapterFiles.length) {
      return NextResponse.json({
        error: `${failedChapterFiles.length} chapter${failedChapterFiles.length === 1 ? '' : 's'} require${failedChapterFiles.length === 1 ? 's' : ''} review and successful replacement recording before full-book download.`,
        code: 'AUDIOBOOK_CHAPTER_REVIEW_REQUIRED',
        failedChapterFiles,
      }, { status: 409 });
    }
    let chapters = listChapterObjects(objectNames);
    if (chapters.length === 0) {
      console.log('DEBUG 404: No chapters found', { bookId, storageUserId, testNamespace, objectNames, objectsLength: objects.length });
      return NextResponse.json({ error: 'No chapters found' }, { status: 404 });
    }

    const chapterRows = await db
      .select({
        chapterIndex: audiobookChapters.chapterIndex,
        duration: audiobookChapters.duration,
        title: audiobookChapters.title,
      })
      .from(audiobookChapters)
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, storageUserId)));
    const durationByIndex = new Map<number, number>();
    const titleByIndex = new Map<number, string>();
    for (const row of chapterRows) {
      durationByIndex.set(row.chapterIndex, Number(row.duration ?? 0));
      if (row.title.trim()) titleByIndex.set(row.chapterIndex, row.title.trim());
    }
    chapters = chapters.map((chapter) => ({
      ...chapter,
      title: titleByIndex.get(chapter.index) ?? chapter.title,
    }));

    const chapterFormats = new Set(chapters.map((chapter) => chapter.format));
    if (chapterFormats.size > 1) {
      return NextResponse.json({ error: 'Mixed chapter formats detected; reset the audiobook to continue' }, { status: 400 });
    }

    const format: TTSAudiobookFormat = requestedFormat ?? chapters[0].format;
    const completeName = `complete.${format}`;
    const manifestName = `${completeName}.manifest.json`;
    const signature = chapters.map((chapter) => ({
      index: chapter.index,
      fileName: chapter.fileName,
      title: chapter.title,
    }));

    const rawTitle = existingBookRows[0].title || 'audiobook';
    const safeTitle = rawTitle.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    const downloadFilename = `${safeTitle}.${format}`;

    if (objectNames.includes(completeName) && objectNames.includes(manifestName)) {
      try {
        const manifest = JSON.parse((await getAudiobookObjectBuffer(bookId, storageUserId, manifestName, testNamespace)).toString('utf8'));
        if (JSON.stringify(manifest) === JSON.stringify(signature)) {
          const rangeHeader = request.headers.get('range') || undefined;
          const { body, contentRange, contentLength, acceptRanges } = await getAudiobookRobustStreamWithMetadata(
            bookId, 
            storageUserId, 
            completeName, 
            testNamespace,
            { range: rangeHeader }
          );
          
          const webStream = typeof (body as any).transformToWebStream === 'function'
            ? (body as any).transformToWebStream()
            : Readable.toWeb(body as any);
            
          const headers: Record<string, string> = {
            'Content-Type': chapterFileMimeType(format),
            'Content-Disposition': contentDispositionAttachment(downloadFilename),
            'Cache-Control': 'no-cache',
          };
          
          if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;
          if (contentRange) headers['Content-Range'] = contentRange;
          if (contentLength !== undefined) headers['Content-Length'] = contentLength.toString();

          return new NextResponse(webStream as any, {
            status: contentRange ? 206 : 200,
            headers,
          });
        }
      } catch {
        // Force regeneration below.
      }

      await deleteAudiobookObject(bookId, storageUserId, completeName, testNamespace).catch(() => {});
      await deleteAudiobookObject(bookId, storageUserId, manifestName, testNamespace).catch(() => {});
    }


    return NextResponse.json({ error: 'Audiobook not fully assembled yet or requires regeneration' }, { status: 404 });
  } catch (error) {
    if ((error as Error)?.message === 'ABORTED' || request.signal.aborted) {
      return NextResponse.json({ error: 'cancelled' }, { status: 499 });
    }
    serverLogger.error({
      event: 'audiobook.download.failed',
      error: errorToLog(error),
    }, 'Failed to download full audiobook');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to download audiobook file',
      normalize: { code: 'AUDIOBOOK_DOWNLOAD_FAILED', errorClass: 'upstream' },
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    const requestedFormat = request.nextUrl.searchParams.get('format') as TTSAudiobookFormat | null;
    if (!bookId || !isSafeId(bookId)) {
      return NextResponse.json({ error: 'Invalid bookId parameter' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const storageUserId = ctxOrRes.userId;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const existingBookRows = await db
      .select({ userId: audiobooks.userId, title: audiobooks.title })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));
    if (existingBookRows.length === 0) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const objectNames = objects.map((item) => item.fileName);
    const completeness = await readAudiobookCompleteness(bookId, storageUserId, testNamespace, objectNames);
    if (!completeness.complete) return NextResponse.json({ error: completeness.invalidOmissionChapterIndexes.length
      ? 'Some saved chapter omissions no longer match the pinned source. Retry or review those chapters before full-book export.'
      : 'Audiobook is incomplete. Retry missing chapters before full-book export.',
    code: completeness.activeReviewChapterIndexes.length ? 'AUDIOBOOK_CHAPTER_REVIEW_REQUIRED' : 'AUDIOBOOK_INCOMPLETE',
    missingChapterIndexes: completeness.missingChapterIndexes, invalidOmissionChapterIndexes: completeness.invalidOmissionChapterIndexes }, { status: 409 });
    const failedChapterFiles = objectNames.filter((name) => /^\d{1,6}__rejected\.txt$/u.test(name)
      && !completeness.recordedChapterIndexes.includes(Number(name.split('__')[0]) - 1));
    if (failedChapterFiles.length) {
      return NextResponse.json({
        error: `${failedChapterFiles.length} chapter${failedChapterFiles.length === 1 ? '' : 's'} require${failedChapterFiles.length === 1 ? 's' : ''} review and successful replacement recording before full-book download.`,
        code: 'AUDIOBOOK_CHAPTER_REVIEW_REQUIRED',
        failedChapterFiles,
      }, { status: 409 });
    }
    
    let chapters = listChapterObjects(objectNames);
    if (chapters.length === 0) {
      return NextResponse.json({ error: 'No chapters found' }, { status: 404 });
    }

    const chapterRows = await db
      .select({
        chapterIndex: audiobookChapters.chapterIndex,
        title: audiobookChapters.title,
      })
      .from(audiobookChapters)
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, storageUserId)));
    const titleByIndex = new Map<number, string>();
    for (const row of chapterRows) {
      if (row.title.trim()) titleByIndex.set(row.chapterIndex, row.title.trim());
    }
    chapters = chapters.map((chapter) => ({
      ...chapter,
      title: titleByIndex.get(chapter.index) ?? chapter.title,
    }));
    
    const format: TTSAudiobookFormat = requestedFormat ?? chapters[0].format;
    const completeName = `complete.${format}`;
    const manifestName = `${completeName}.manifest.json`;
    const signature = chapters.map((chapter) => ({
      index: chapter.index,
      fileName: chapter.fileName,
      title: chapter.title,
    }));

    if (objectNames.includes(completeName) && objectNames.includes(manifestName)) {
      try {
        const manifest = JSON.parse((await getAudiobookObjectBuffer(bookId, storageUserId, manifestName, testNamespace)).toString('utf8'));
        if (JSON.stringify(manifest) === JSON.stringify(signature)) {
          return NextResponse.json({ success: true, message: 'Audiobook already combined', status: 'ready' });
        }
      } catch {}
      await deleteAudiobookObject(bookId, storageUserId, completeName, testNamespace).catch(() => {});
      await deleteAudiobookObject(bookId, storageUserId, manifestName, testNamespace).catch(() => {});
    }

    // Insert or update combine job
    const existingJobs = await db.select().from(audiobookJobs)
      .where(and(
        eq(audiobookJobs.documentId, bookId),
        eq(audiobookJobs.userId, storageUserId),
        inArray(audiobookJobs.status, ['queued', 'running'])
      ));
      
    let isCombining = false;
    for (const job of existingJobs) {
      const settings = typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : (job.settingsJson || {});
      if (settings.jobType === 'combine' && settings.format === format) {
        isCombining = true;
        break;
      }
    }
    
    if (!isCombining) {
      const jobId = crypto.randomUUID();
      await db.insert(audiobookJobs).values({
        id: jobId,
        userId: storageUserId,
        documentId: bookId,
        status: 'queued',
        progress: 0,
        settingsJson: { jobType: 'combine', format, testNamespace },
      });
    }

    return NextResponse.json({ success: true, message: 'Audiobook combination queued', status: 'queued' });
  } catch (error) {
    serverLogger.error({
      event: 'audiobook.combine.failed',
      error: errorToLog(error),
    }, 'Failed to queue audiobook combine');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to queue audiobook combine',
      normalize: { code: 'AUDIOBOOK_COMBINE_FAILED', errorClass: 'upstream' },
    });
  }
}
export async function DELETE(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    if (!bookId) {
      return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
    }
    if (!isSafeId(bookId)) {
      return NextResponse.json({ error: 'Invalid bookId parameter' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const storageUserId = ctxOrRes.userId;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const existingBookRows = await db
      .select({ userId: audiobooks.userId })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));

    if (existingBookRows.length === 0) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    await db
      .delete(audiobookChapters)
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, storageUserId)));

    await db.delete(audiobookJobs).where(and(eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, storageUserId)));

    await db.delete(audiobooks).where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));

    const deleted = await deleteAudiobookPrefix(audiobookPrefix(bookId, storageUserId, testNamespace)).catch(() => 0);
    return NextResponse.json({ success: true, existed: deleted > 0 });
  } catch (error) {
    serverLogger.error({
      event: 'audiobook.reset.failed',
      error: errorToLog(error),
    }, 'Failed to reset audiobook');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to reset audiobook',
      normalize: { code: 'AUDIOBOOK_RESET_FAILED', errorClass: 'db' },
    });
  }
}
