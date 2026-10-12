import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/db';
import { documentSettings, documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { errorResponse } from '@/lib/server/errors/next-response';
import { serverLogger } from '@/lib/server/logger';
import { mergeDocumentSettings, normalizeSmartAudioReviewFlags } from '@/lib/shared/document-settings';
import { isDramaRecoveryNotice } from '@/lib/shared/drama-diagnostic-notices';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  type SmartAudioReviewFlag,
} from '@/types/document-settings';

export const dynamic = 'force-dynamic';

function parseSettings(value: unknown) {
  if (typeof value === 'string') {
    try { return mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, JSON.parse(value)); } catch { /* fall through */ }
  }
  return mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, value);
}

async function loadOwnedFlags(request: NextRequest, documentId: string) {
  const context = await requireAuthContext(request);
  if (context instanceof Response) return context;
  if (!context.userId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const document = await db.select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, context.userId)))
    .limit(1);
  if (!document[0]) return NextResponse.json({ error: 'Document not found.' }, { status: 404 });
  const rows = await db.select({ dataJson: documentSettings.dataJson })
    .from(documentSettings)
    .where(and(
      eq(documentSettings.documentId, documentId),
      eq(documentSettings.userId, context.userId),
    ))
    .limit(1);
  return {
    userId: context.userId,
    flags: parseSettings(rows[0]?.dataJson).smartAudioReviewFlags || [],
  };
}

async function saveFlags(input: {
  documentId: string;
  userId: string;
  flags: SmartAudioReviewFlag[];
}) {
  const flags = normalizeSmartAudioReviewFlags(input.flags);
  const serialized = JSON.stringify(flags);
  const initialData = process.env.POSTGRES_URL
    ? { schemaVersion: 1, smartAudioReviewFlags: flags }
    : JSON.stringify({ schemaVersion: 1, smartAudioReviewFlags: flags });
  const mergedData = process.env.POSTGRES_URL
    ? sql`jsonb_set(coalesce(${documentSettings.dataJson}, '{}'::jsonb), '{smartAudioReviewFlags}', ${serialized}::jsonb, true)`
    : sql`json_set(coalesce(${documentSettings.dataJson}, '{}'), '$.smartAudioReviewFlags', json(${serialized}))`;
  await db.insert(documentSettings).values({
    documentId: input.documentId,
    userId: input.userId,
    dataJson: initialData as never,
    clientUpdatedAtMs: 0,
    updatedAt: Date.now(),
  }).onConflictDoUpdate({
    target: [documentSettings.documentId, documentSettings.userId],
    set: { dataJson: mergedData as never, updatedAt: Date.now() },
  });
  return flags;
}

function requestDocumentId(request: NextRequest): string {
  return (new URL(request.url).searchParams.get('documentId') || '').trim().toLowerCase();
}

export async function GET(request: NextRequest) {
  try {
    const documentId = requestDocumentId(request);
    if (!documentId) return NextResponse.json({ error: 'Document ID is required.' }, { status: 400 });
    const scope = await loadOwnedFlags(request, documentId);
    if (scope instanceof Response) return scope;
    const chapterParam = new URL(request.url).searchParams.get('chapterIndex');
    const chapterIndex = chapterParam === null ? null : Number(chapterParam);
    const flags = scope.flags.filter((flag) => (
      !flag.resolvedAt && !isDramaRecoveryNotice(flag) && (chapterIndex === null || flag.chapterIndex === chapterIndex)
    ));
    return NextResponse.json({ flags });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'audiobook.review_flags.load_failed',
      apiErrorMessage: 'Failed to load audiobook review flags.',
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const documentId = typeof body.documentId === 'string' ? body.documentId.trim().toLowerCase() : '';
    const chapterIndex = Number(body.chapterIndex);
    const timestampMs = Number(body.timestampMs);
    if (!documentId || !Number.isInteger(chapterIndex) || chapterIndex < 0
      || !Number.isFinite(timestampMs) || timestampMs < 0) {
      return NextResponse.json({ error: 'A valid document, chapter, and timestamp are required.' }, { status: 400 });
    }
    const scope = await loadOwnedFlags(request, documentId);
    if (scope instanceof Response) return scope;
    const flag: SmartAudioReviewFlag = {
      id: randomUUID(),
      chapterIndex,
      timestampMs: Math.round(timestampMs),
      createdAt: Date.now(),
    };
    await saveFlags({ documentId, userId: scope.userId, flags: [...scope.flags, flag] });
    return NextResponse.json({ flag }, { status: 201 });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'audiobook.review_flags.create_failed',
      apiErrorMessage: 'Failed to save the audiobook review flag.',
    });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const documentId = typeof body.documentId === 'string' ? body.documentId.trim().toLowerCase() : '';
    const flagId = typeof body.flagId === 'string' ? body.flagId.trim() : '';
    if (!documentId || !flagId) {
      return NextResponse.json({ error: 'Document ID and flag ID are required.' }, { status: 400 });
    }
    const scope = await loadOwnedFlags(request, documentId);
    if (scope instanceof Response) return scope;
    if (!scope.flags.some((flag) => flag.id === flagId)) {
      return NextResponse.json({ error: 'Review flag not found.' }, { status: 404 });
    }
    const resolvedAt = Date.now();
    const flags = scope.flags.map((flag) => flag.id === flagId ? { ...flag, resolvedAt } : flag);
    await saveFlags({ documentId, userId: scope.userId, flags });
    return NextResponse.json({ success: true, resolvedAt });
  } catch (error) {
    return errorResponse(error, {
      logger: serverLogger,
      event: 'audiobook.review_flags.resolve_failed',
      apiErrorMessage: 'Failed to resolve the audiobook review flag.',
    });
  }
}
