import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documentSettings } from '@/db/schema';
import type { DocumentSettings } from '@/types/document-settings';
import type { DramaSynthesisReviewFlag } from '@/lib/server/smart-audio/drama-cloud-synthesis';

export async function persistCloudDramaReviewFlags(input: {
  documentId: string;
  userId: string;
  chapterIndex: number;
  flags: readonly DramaSynthesisReviewFlag[];
}): Promise<void> {
  if (!input.flags.length) return;
  const condition = and(eq(documentSettings.documentId, input.documentId), eq(documentSettings.userId, input.userId));
  const [row] = await db.select({ dataJson: documentSettings.dataJson }).from(documentSettings).where(condition).limit(1);
  if (!row) throw new Error('Document settings are unavailable for Cloud Drama review flags.');
  const settings = (typeof row.dataJson === 'string' ? JSON.parse(row.dataJson) : row.dataJson) as DocumentSettings;
  settings.smartAudioReviewFlags = [
    ...(settings.smartAudioReviewFlags || []),
    ...input.flags.map((flag) => ({
      id: randomUUID(), chapterIndex: input.chapterIndex, timestampMs: 0, createdAt: Date.now(),
      kind: flag.kind, speaker: flag.speaker, sourceText: flag.sourceText,
      reason: flag.reason, chunkIndex: flag.chunkIndex, attempts: flag.attempts,
    })),
  ];
  await db.update(documentSettings).set({ dataJson: JSON.stringify(settings) }).where(condition);
}
