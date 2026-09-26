import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookJobs, audiobooks, documentSettings, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  getAudiobookObjectBuffer,
  listAudiobookObjects,
  isMissingBlobError,
} from '@/lib/server/audiobooks/blobstore';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { normalizeSmartAudioReviewFlags } from '@/lib/shared/document-settings';
import type { SmartAudioReviewFlag } from '@/types/document-settings';

export const dynamic = 'force-dynamic';

export interface ChapterFailureLogItem {
  chapterIndex: number;
  chapterTitle?: string;
  errors: string[];
  createdAt?: number;
  jobId?: string;
  profileId?: string;
  sourceText?: string;
}

export interface AudiobookFailureLogResponse {
  bookId: string;
  documentTitle?: string;
  jobError?: string | null;
  jobStatus?: string | null;
  failures: ChapterFailureLogItem[];
  reviewFlags: SmartAudioReviewFlag[];
}

export async function GET(request: NextRequest) {
  try {
    const bookId = request.nextUrl.searchParams.get('bookId');
    if (!bookId) {
      return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
    }

    const chapterIndexParam = request.nextUrl.searchParams.get('chapterIndex');
    const targetChapterIndex = chapterIndexParam !== null ? parseInt(chapterIndexParam, 10) : null;
    if (targetChapterIndex !== null && (isNaN(targetChapterIndex) || targetChapterIndex < 0)) {
      return NextResponse.json({ error: 'Invalid chapterIndex parameter' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const storageUserId = ctxOrRes.userId;
    const testNamespace = getOpenReaderTestNamespace(request.headers);

    // Fetch document / audiobook metadata
    const [audiobookRow] = await db
      .select({ id: audiobooks.id, title: audiobooks.title })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)))
      .limit(1);

    const [docRow] = !audiobookRow
      ? await db
          .select({ id: documents.id, name: documents.name })
          .from(documents)
          .where(and(eq(documents.id, bookId), eq(documents.userId, storageUserId)))
          .limit(1)
      : [null];

    const documentTitle = audiobookRow?.title || docRow?.name || 'Audiobook';

    // Fetch latest background job for this document
    const [job] = await db
      .select({
        id: audiobookJobs.id,
        status: audiobookJobs.status,
        error: audiobookJobs.error,
        createdAt: audiobookJobs.createdAt,
      })
      .from(audiobookJobs)
      .where(and(eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, storageUserId)))
      .orderBy(desc(audiobookJobs.createdAt))
      .limit(1);

    // Fetch document settings review flags
    const [settingsRow] = await db
      .select({ dataJson: documentSettings.dataJson })
      .from(documentSettings)
      .where(and(eq(documentSettings.documentId, bookId), eq(documentSettings.userId, storageUserId)))
      .limit(1);

    let allReviewFlags: SmartAudioReviewFlag[] = [];
    if (settingsRow?.dataJson) {
      try {
        const parsed = typeof settingsRow.dataJson === 'string'
          ? JSON.parse(settingsRow.dataJson)
          : settingsRow.dataJson;
        allReviewFlags = normalizeSmartAudioReviewFlags(parsed.smartAudioReviewFlags || []);
      } catch {
        allReviewFlags = [];
      }
    }

    const filteredReviewFlags = targetChapterIndex !== null
      ? allReviewFlags.filter((f) => f.chapterIndex === targetChapterIndex)
      : allReviewFlags;

    // List objects from blobstore
    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const failures: ChapterFailureLogItem[] = [];
    const processedIndices = new Set<number>();

    if (targetChapterIndex !== null) {
      const prefix = String(targetChapterIndex + 1).padStart(4, '0');
      const targetFileName = `${prefix}__pronunciation_failure.json`;
      const match = objects.find((o) => o.fileName === targetFileName);
      if (match) {
        try {
          const buf = await getAudiobookObjectBuffer(bookId, storageUserId, match.fileName, testNamespace);
          const parsed = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
          failures.push({
            chapterIndex: targetChapterIndex,
            chapterTitle: (parsed.chapterTitle as string) || `Chapter ${targetChapterIndex + 1}`,
            errors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [],
            createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
            jobId: typeof parsed.jobId === 'string' ? parsed.jobId : undefined,
            profileId: typeof parsed.profileId === 'string' ? parsed.profileId : undefined,
            sourceText: typeof parsed.sourceText === 'string' ? parsed.sourceText : undefined,
          });
          processedIndices.add(targetChapterIndex);
        } catch (e) {
          if (!isMissingBlobError(e)) throw e;
        }
      }

      // If no file was found but there are review flags for this chapter, synthesize a failure item
      if (!processedIndices.has(targetChapterIndex) && filteredReviewFlags.length > 0) {
        failures.push({
          chapterIndex: targetChapterIndex,
          chapterTitle: `Chapter ${targetChapterIndex + 1}`,
          errors: filteredReviewFlags.map((f) => `${f.speaker ? `[${f.speaker}] ` : ''}${f.reason || f.kind}`),
          createdAt: filteredReviewFlags[0]?.createdAt,
        });
      }
    } else {
      // Find all pronunciation failure objects
      const failureObjects = objects.filter((o) => o.fileName.endsWith('__pronunciation_failure.json'));
      const parsedResults = await Promise.allSettled(
        failureObjects.map(async (obj) => {
          const buf = await getAudiobookObjectBuffer(bookId, storageUserId, obj.fileName, testNamespace);
          const parsed = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
          const matchIndex = obj.fileName.match(/^(\d{4})__/);
          const fallbackIndex = matchIndex ? parseInt(matchIndex[1], 10) - 1 : 0;
          const chapterIndex = typeof parsed.chapterIndex === 'number' ? parsed.chapterIndex : fallbackIndex;
          return {
            chapterIndex,
            chapterTitle: (parsed.chapterTitle as string) || `Chapter ${chapterIndex + 1}`,
            errors: Array.isArray(parsed.errors) ? parsed.errors.map(String) : [],
            createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
            jobId: typeof parsed.jobId === 'string' ? parsed.jobId : undefined,
            profileId: typeof parsed.profileId === 'string' ? parsed.profileId : undefined,
            sourceText: typeof parsed.sourceText === 'string' ? parsed.sourceText : undefined,
          };
        })
      );

      for (const res of parsedResults) {
        if (res.status === 'fulfilled') {
          failures.push(res.value);
          processedIndices.add(res.value.chapterIndex);
        }
      }

      // Check review flags for chapters without an explicit failure file
      const flaggedChapterIndices = Array.from(new Set(allReviewFlags.map((f) => f.chapterIndex)));
      for (const idx of flaggedChapterIndices) {
        if (idx !== undefined && !processedIndices.has(idx)) {
          const chapterFlags = allReviewFlags.filter((f) => f.chapterIndex === idx);
          failures.push({
            chapterIndex: idx,
            chapterTitle: `Chapter ${idx + 1}`,
            errors: chapterFlags.map((f) => `${f.speaker ? `[${f.speaker}] ` : ''}${f.reason || f.kind}`),
            createdAt: chapterFlags[0]?.createdAt,
          });
          processedIndices.add(idx);
        }
      }

      failures.sort((a, b) => a.chapterIndex - b.chapterIndex);
    }

    const responseData: AudiobookFailureLogResponse = {
      bookId,
      documentTitle,
      jobError: job?.error ?? null,
      jobStatus: job?.status ?? null,
      failures,
      reviewFlags: filteredReviewFlags,
    };

    return NextResponse.json(responseData);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to retrieve audiobook failure log' },
      { status: 500 },
    );
  }
}
