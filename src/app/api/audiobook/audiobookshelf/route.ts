import { NextRequest, NextResponse } from 'next/server';
export const maxDuration = 300; // 5 minute max duration for large audiobook combine and upload
import { requireAuthContext } from '@/lib/server/auth/auth';
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

    const namespace = getOpenReaderTestNamespace(req.headers);

    const result = await uploadBookToAudiobookshelf({
      bookId,
      userId: ctxOrRes.userId,
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
