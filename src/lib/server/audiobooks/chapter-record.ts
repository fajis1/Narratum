import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookChapters } from '@/db/schema';

/** Reuse legacy row IDs; deterministic IDs make concurrent new writes idempotent. */
export async function persistAudiobookChapter(input: Omit<typeof audiobookChapters.$inferInsert, 'id'>) {
  const [existing] = await db.select({ id: audiobookChapters.id }).from(audiobookChapters)
    .where(and(eq(audiobookChapters.bookId, input.bookId), eq(audiobookChapters.userId, input.userId), eq(audiobookChapters.chapterIndex, input.chapterIndex))).limit(1);
  const id = existing?.id ?? `${input.bookId}-${input.chapterIndex}`;
  await db.insert(audiobookChapters).values({ ...input, id }).onConflictDoUpdate({
    target: [audiobookChapters.id, audiobookChapters.userId],
    set: { title: input.title, duration: input.duration, format: input.format, filePath: input.filePath },
  });
}
