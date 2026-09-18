import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { inferDocumentMetadataWithGemini } from '@/lib/server/audiobooks/metadata-inference';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

async function resolveOwnerUserId(
  bookId: string,
  requesterUserId: string,
  isAdmin: boolean,
  requestedUserId?: string | null,
): Promise<string> {
  if (!isAdmin) return requesterUserId;
  if (requestedUserId && requestedUserId.trim()) {
    return requestedUserId.trim();
  }

  const bookRows = await db
    .select({ userId: audiobooks.userId })
    .from(audiobooks)
    .where(eq(audiobooks.id, bookId))
    .limit(1);
  if (bookRows.length > 0 && bookRows[0].userId) {
    return bookRows[0].userId;
  }

  const docRows = await db
    .select({ userId: documents.userId })
    .from(documents)
    .where(eq(documents.id, bookId))
    .limit(1);
  if (docRows.length > 0 && docRows[0].userId) {
    return docRows[0].userId;
  }

  return requesterUserId;
}

export async function GET(req: NextRequest) {
  const ctxOrRes = await requireAuthContext(req);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bookId = req.nextUrl.searchParams.get('bookId');
  if (!bookId) {
    return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
  }

  const isAdmin = Boolean((ctxOrRes.user as unknown as { isAdmin?: boolean | null })?.isAdmin);
  const requestedUserId = req.nextUrl.searchParams.get('userId');
  const ownerUserId = await resolveOwnerUserId(bookId, ctxOrRes.userId, isAdmin, requestedUserId);

  const namespace = getOpenReaderTestNamespace(req.headers);

  try {
    const metadata = await inferDocumentMetadataWithGemini({
      bookId,
      userId: ownerUserId,
      namespace,
    });
    return NextResponse.json({ success: true, metadata });
  } catch (error) {
    serverLogger.warn(
      { event: 'audiobook.metadata.infer_route_failed', bookId, error: errorToLog(error) },
      'Failed to infer audiobook metadata',
    );
    return NextResponse.json(
      { success: false, error: (error as Error)?.message || 'Failed to infer metadata' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const ctxOrRes = await requireAuthContext(req);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { bookId?: string; userId?: string };
  const bookId = body.bookId || req.nextUrl.searchParams.get('bookId');
  if (!bookId) {
    return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
  }

  const isAdmin = Boolean((ctxOrRes.user as unknown as { isAdmin?: boolean | null })?.isAdmin);
  const requestedUserId = body.userId || req.nextUrl.searchParams.get('userId');
  const ownerUserId = await resolveOwnerUserId(bookId, ctxOrRes.userId, isAdmin, requestedUserId);

  const namespace = getOpenReaderTestNamespace(req.headers);

  try {
    const metadata = await inferDocumentMetadataWithGemini({
      bookId,
      userId: ownerUserId,
      namespace,
    });
    return NextResponse.json({ success: true, metadata });
  } catch (error) {
    serverLogger.warn(
      { event: 'audiobook.metadata.infer_route_failed', bookId, error: errorToLog(error) },
      'Failed to infer audiobook metadata',
    );
    return NextResponse.json(
      { success: false, error: (error as Error)?.message || 'Failed to infer metadata' },
      { status: 500 },
    );
  }
}
