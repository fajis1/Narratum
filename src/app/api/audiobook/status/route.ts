import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, audiobookChapters, audiobookJobs } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getAudiobookObjectBuffer, isMissingBlobError, listAudiobookObjects } from '@/lib/server/audiobooks/blobstore';
import { decodeChapterFileName, listChapterObjects } from '@/lib/server/audiobooks/chapters';
import { pruneAudiobookChaptersNotOnDisk } from '@/lib/server/audiobooks/prune';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudiobookChapter, TTSAudiobookFormat } from '@/types/tts';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

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

export async function GET(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    if (!bookId || !isSafeId(bookId)) {
      return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
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
      return NextResponse.json({
        chapters: [],
        exists: false,
        hasComplete: false,
        bookId: null,
        settings: null,
      });
    }

    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const objectNames = objects.map((object) => object.fileName);
    const chapterObjects = listChapterObjects(objectNames);

    await pruneAudiobookChaptersNotOnDisk(
      bookId,
      storageUserId,
      chapterObjects.map((chapter) => chapter.index),
    );

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

    const allChapterIndices = new Set<number>();
    for (const chapter of chapterObjects) {
      allChapterIndices.add(chapter.index);
    }
    for (const fileName of objectNames) {
      const match = /^(\d{1,6})__/u.exec(fileName);
      if (match) {
        const idx = Number.parseInt(match[1], 10) - 1;
        if (Number.isInteger(idx) && idx >= 0) {
          allChapterIndices.add(idx);
        }
      }
    }
    for (const row of chapterRows) {
      allChapterIndices.add(row.chapterIndex);
    }

    const sortedIndices = Array.from(allChapterIndices).sort((a, b) => a - b);
    const chapterObjByIndex = new Map(chapterObjects.map((c) => [c.index, c]));

    const chapters: TTSAudiobookChapter[] = sortedIndices.map((index) => {
      const oneBasedPrefix = String(index + 1).padStart(4, '0') + '__';
      const chapterObj = chapterObjByIndex.get(index);
      const chapter = {
        index,
        title: chapterObj?.title ?? `Chapter ${index + 1}`,
      };
      const txtFileObj = objects.find(
        (o) => o.fileName.startsWith(oneBasedPrefix) && (
          o.fileName.endsWith('__text.txt') ||
          o.fileName.endsWith('__rejected.txt') ||
          (o.fileName.endsWith('.txt') && !o.fileName.endsWith('__original.txt') && !o.fileName.endsWith('__changelog.txt'))
        )
      );
      const hasRejected = objects.some((o) => o.fileName === `${oneBasedPrefix}rejected.txt`);
      const hasFailure = objects.some((o) => o.fileName === `${oneBasedPrefix}pronunciation_failure.json`);
      const isEmptyText = !txtFileObj || txtFileObj.size < 5; // empty or extremely small
      const hasAudio = Boolean(chapterObj);
      const needsReview = hasRejected || hasFailure || isEmptyText || !hasAudio;

      return {
        index: chapter.index,
        title: titleByIndex.get(chapter.index) ?? chapter.title,
        duration: durationByIndex.get(chapter.index),
        status: (hasRejected || hasFailure) ? 'error' : (!hasAudio ? 'pending' : 'completed'),
        bookId,
        format: chapterObj?.format ?? 'mp3',
        isEmptyText,
        hasAudio,
        hasRejected,
        hasFailure,
        needsReview,
      };
    });

    let settings: AudiobookGenerationSettings | null = null;
    try {
      settings = JSON.parse((await getAudiobookObjectBuffer(bookId, storageUserId, 'audiobook.meta.json', testNamespace)).toString('utf8')) as AudiobookGenerationSettings;
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      settings = null;
    }

    const hasComplete = objectNames.includes('complete.mp3') || objectNames.includes('complete.m4b');
    const exists = chapters.length > 0 || hasComplete || settings !== null;

    if (!exists) {
      // Check if there's an active job before deleting to prevent race condition
      const activeJobs = await db
        .select({ id: audiobookJobs.id })
        .from(audiobookJobs)
        .where(and(eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, storageUserId)));
      
      if (activeJobs.length === 0) {
        // Deleting the audiobook row cascades to audiobookChapters via bookFk
        await db.delete(audiobooks).where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));
      }
      return NextResponse.json({
        chapters: [],
        exists: false,
        hasComplete: false,
        bookId: null,
        settings: null,
      });
    }

    return NextResponse.json({
      chapters,
      exists: true,
      hasComplete,
      bookId,
      settings,
    });
  } catch (error) {
    serverLogger.error({
      event: 'audiobook.status.fetch.failed',
      error: errorToLog(error),
    }, 'Failed to fetch audiobook chapters');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to fetch chapters',
      normalize: { code: 'AUDIOBOOK_STATUS_FETCH_FAILED', errorClass: 'db' },
    });
  }
}
