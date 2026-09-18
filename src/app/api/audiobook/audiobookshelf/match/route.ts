import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  fetchAudiobookshelfLibraries,
  matchAudiobookshelfCandidateWithGemini,
  resolveAudiobookshelfConfig,
  searchAudiobookshelfCandidates,
} from '@/lib/server/audiobooks/audiobookshelf';
import { errorToLog, serverLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ctxOrRes = await requireAuthContext(req);
  if (ctxOrRes instanceof Response) return ctxOrRes;
  if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      bookId?: string;
      userId?: string;
      libraryId?: string;
      title?: string;
      author?: string;
      model?: string;
    };

    const bookId = body.bookId;
    if (!bookId) {
      return NextResponse.json({ error: 'Missing required parameter: bookId' }, { status: 400 });
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

    // 1. Resolve title and author if not supplied
    let title = (body.title || '').trim();
    let author = (body.author || '').trim();

    if (!title) {
      const bookRows = await db
        .select({ title: audiobooks.title, author: audiobooks.author })
        .from(audiobooks)
        .where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, ownerUserId)));

      if (bookRows.length > 0) {
        title = bookRows[0].title || '';
        if (!author && bookRows[0].author) author = bookRows[0].author;
      } else {
        const docRows = await db
          .select({ name: documents.name })
          .from(documents)
          .where(and(eq(documents.id, bookId), eq(documents.userId, ownerUserId)));
        if (docRows.length > 0) {
          title = docRows[0].name.replace(/\.[a-zA-Z0-9]+$/, '');
        }
      }
    }

    if (!title) {
      return NextResponse.json({ error: 'Could not resolve book title' }, { status: 400 });
    }

    // 2. Resolve Audiobookshelf config
    const config = await resolveAudiobookshelfConfig();
    if (!config.isConfigured) {
      return NextResponse.json({
        matchFound: false,
        candidate: null,
        confidence: 0,
        reasoning: 'Audiobookshelf is not configured.',
      });
    }

    // 3. Resolve target library ID
    let targetLibraryId = body.libraryId?.trim() || config.libraryId;
    if (!targetLibraryId) {
      try {
        const libs = await fetchAudiobookshelfLibraries(config.url, config.token);
        if (libs.length > 0) {
          targetLibraryId = libs[0].id;
        }
      } catch {
        // non-fatal
      }
    }

    if (!targetLibraryId) {
      return NextResponse.json({
        matchFound: false,
        candidate: null,
        confidence: 0,
        reasoning: 'No Audiobookshelf library specified or configured.',
      });
    }

    // 4. Query Audiobookshelf search API for candidates
    const candidates = await searchAudiobookshelfCandidates(
      config.url,
      config.token,
      targetLibraryId,
      title,
      author || undefined,
    );

    if (candidates.length === 0) {
      return NextResponse.json({
        matchFound: false,
        candidate: null,
        confidence: 0,
        reasoning: 'No existing candidate items found in Audiobookshelf library.',
        candidates: [],
      });
    }

    // 5. Run AI matching
    const matchResult = await matchAudiobookshelfCandidateWithGemini(
      candidates,
      title,
      author || undefined,
      {
        userId: ownerUserId,
        model: body.model?.trim() || 'gemini-3.1-flash-lite',
      },
    );

    const matchedCandidate = matchResult.isMatch && matchResult.matchedItemId
      ? candidates.find((c) => c.id === matchResult.matchedItemId) || null
      : null;

    return NextResponse.json({
      matchFound: matchResult.isMatch && Boolean(matchedCandidate),
      candidate: matchedCandidate,
      confidence: matchResult.confidence,
      reasoning: matchResult.reasoning,
      candidates,
    });
  } catch (error) {
    serverLogger.error(
      { event: 'audiobook.audiobookshelf.match_route_error', error: errorToLog(error) },
      'Audiobookshelf match route failed',
    );
    return NextResponse.json(
      {
        matchFound: false,
        candidate: null,
        confidence: 0,
        reasoning: (error as Error)?.message || 'Failed to match candidate book.',
      },
      { status: 500 },
    );
  }
}
