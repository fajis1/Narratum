import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getAudiobookObjectBuffer, isMissingBlobError } from '@/lib/server/audiobooks/blobstore';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const bookId = request.nextUrl.searchParams.get('bookId');
    const chapterIndexStr = request.nextUrl.searchParams.get('chapterIndex');
    
    if (!bookId || !chapterIndexStr) {
      return NextResponse.json({ error: 'Missing bookId or chapterIndex' }, { status: 400 });
    }

    const chapterIndex = parseInt(chapterIndexStr, 10);
    if (isNaN(chapterIndex) || chapterIndex < 0) {
      return NextResponse.json({ error: 'Invalid chapterIndex' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const storageUserId = ctxOrRes.userId;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const type = request.nextUrl.searchParams.get('type');
    const prefix = String(chapterIndex + 1).padStart(4, '0');

    let textBuffer: Buffer | null = null;
    if (type === 'original') {
      try {
        textBuffer = await getAudiobookObjectBuffer(bookId, storageUserId, `${prefix}__original.txt`, testNamespace);
      } catch (e) {
        if (!isMissingBlobError(e)) throw e;
      }
    } else if (type === 'rejected') {
      try {
        textBuffer = await getAudiobookObjectBuffer(bookId, storageUserId, `${prefix}__rejected.txt`, testNamespace);
      } catch (e) {
        if (!isMissingBlobError(e)) throw e;
      }
    } else {
      // Default: try __text.txt first, then fallback to __rejected.txt if this chapter was rejected
      try {
        textBuffer = await getAudiobookObjectBuffer(bookId, storageUserId, `${prefix}__text.txt`, testNamespace);
      } catch (e) {
        if (!isMissingBlobError(e)) throw e;
      }
      if (!textBuffer) {
        try {
          textBuffer = await getAudiobookObjectBuffer(bookId, storageUserId, `${prefix}__rejected.txt`, testNamespace);
        } catch (e) {
          if (!isMissingBlobError(e)) throw e;
        }
      }
    }

    if (!textBuffer) {
      return NextResponse.json({ error: 'Text file not found for this chapter' }, { status: 404 });
    }

    return new NextResponse(textBuffer.toString('utf-8'), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  } catch (error) {
    serverLogger.error({
      event: 'audiobook.text.fetch.failed',
      error: errorToLog(error),
    }, 'Failed to fetch audiobook chapter text');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
