import { NextRequest, NextResponse } from 'next/server';
export const maxDuration = 300; // 5 minute max duration for large audiobook combine and upload
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { recordSupportAudit } from '@/lib/server/admin/support';
import {
  fetchAudiobookshelfLibraries,
  resolveAudiobookshelfConfig,
  uploadBookToAudiobookshelf,
} from '@/lib/server/audiobooks/audiobookshelf';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctxOrRes = await requireAuthContext(req);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const config = await resolveAudiobookshelfConfig();
    if (!config.isConfigured) {
      return NextResponse.json({
        configured: false,
        message: 'Audiobookshelf is not configured. Please enter your server URL and API token in Admin Settings.',
      });
    }

    let libraries: unknown[] = [];
    try {
      libraries = await fetchAudiobookshelfLibraries();
    } catch {
      // Return configured=true even if libraries fetch fails so the UI can report connection issues
    }

    return NextResponse.json({
      configured: true,
      url: config.url,
      defaultLibraryId: config.libraryId,
      defaultFolderId: config.folderId,
      autoDetectMetadata: config.autoDetectMetadata,
      libraries,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error)?.message || 'Failed to fetch Audiobookshelf status' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const ctxOrRes = await requireAuthContext(req);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      bookId?: string;
      userId?: string;
      title?: string;
      author?: string;
      series?: string;
      includeCompanionDocument?: boolean;
      libraryId?: string;
      folderId?: string;
      smartMatchExistingBook?: boolean;
      targetItemId?: string;
      targetFolderName?: string;
      model?: string;
    };

    const bookId = body.bookId;
    if (!bookId) {
      return NextResponse.json({ error: 'Missing required parameter: bookId' }, { status: 400 });
    }

    const title = (body.title || '').trim();
    if (!title) {
      return NextResponse.json({ error: 'Missing required parameter: title' }, { status: 400 });
    }

    const isAdmin = Boolean((ctxOrRes.user as unknown as { isAdmin?: boolean | null })?.isAdmin);
    let ownerUserId = ctxOrRes.userId;

    if (isAdmin) {
      if (body.userId && body.userId.trim()) {
        ownerUserId = body.userId.trim();
      } else {
        const bookRows = await db
          .select({ userId: audiobooks.userId })
          .from(audiobooks)
          .where(eq(audiobooks.id, bookId))
          .limit(1);
        if (bookRows.length > 0 && bookRows[0].userId) {
          ownerUserId = bookRows[0].userId;
        } else {
          const docRows = await db
            .select({ userId: documents.userId })
            .from(documents)
            .where(eq(documents.id, bookId))
            .limit(1);
          if (docRows.length > 0 && docRows[0].userId) {
            ownerUserId = docRows[0].userId;
          }
        }
      }
    }

    const namespace = getOpenReaderTestNamespace(req.headers);

    const result = await uploadBookToAudiobookshelf({
      bookId,
      userId: ownerUserId,
      title,
      author: body.author?.trim(),
      series: body.series?.trim(),
      includeCompanionDocument: body.includeCompanionDocument ?? true,
      libraryId: body.libraryId?.trim(),
      folderId: body.folderId?.trim(),
      smartMatchExistingBook: body.smartMatchExistingBook,
      targetItemId: body.targetItemId?.trim(),
      targetFolderName: body.targetFolderName?.trim(),
      model: body.model?.trim(),
      namespace,
    });

    if (isAdmin && (ownerUserId !== ctxOrRes.userId || body.userId)) {
      await recordSupportAudit({
        adminUserId: ctxOrRes.userId,
        targetUserId: ownerUserId,
        action: 'audiobookshelf_upload',
        resourceId: bookId,
        note: `Exported audiobook "${title}" to Audiobookshelf${result.unified ? ' (merged into existing card)' : ''}`,
      }).catch((auditError) => {
        serverLogger.warn(
          { event: 'support.audit.audiobookshelf_failed', error: errorToLog(auditError) },
          'Failed to record support audit for Audiobookshelf export',
        );
      });
    }

    const successMessage = result.unified
      ? `Successfully unified "${result.title}" with existing Audiobookshelf book!`
      : `Successfully uploaded "${result.title}" to Audiobookshelf!`;

    return NextResponse.json({
      success: true,
      message: successMessage,
      result,
    });
  } catch (error) {
    serverLogger.error(
      { event: 'audiobook.audiobookshelf.upload_route_failed', error: errorToLog(error) },
      'Audiobookshelf upload route encountered an error',
    );
    return NextResponse.json(
      {
        success: false,
        error: (error as Error)?.message || 'Failed to upload to Audiobookshelf',
      },
      { status: 500 },
    );
  }
}
