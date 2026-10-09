import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookJobs, audiobookChapters } from '@/db/schema';
import { getAudiobookObjectBuffer, isMissingBlobError, listAudiobookObjects } from './blobstore';
import { listChapterObjects } from './chapters';

export function missingAudiobookChapters(expected: number[], recorded: number[], omitted: number[] = []): number[] {
  const present = new Set([...recorded, ...omitted]);
  return [...new Set(expected)].filter(index => !present.has(index)).sort((a, b) => a - b);
}

/** Both durable database records and corresponding audio objects are required. */
export async function readAudiobookCompleteness(bookId: string, userId: string, namespace: string | null, names?: string[]) {
  const objectNames = names ?? (await listAudiobookObjects(bookId, userId, namespace)).map(o => o.fileName);
  const jobs = await db.select({ settingsJson: audiobookJobs.settingsJson }).from(audiobookJobs)
    .where(and(eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, userId))).orderBy(desc(audiobookJobs.createdAt));
  const settings = jobs.map((j: { settingsJson: unknown }) => typeof j.settingsJson === 'string' ? JSON.parse(j.settingsJson) : j.settingsJson ?? {})
    .find((s: Record<string, unknown>) => !s.jobType || s.jobType === 'generate') ?? {};
  let expected: number[] = Array.isArray(settings.expectedChapterIndexes) ? settings.expectedChapterIndexes : [];
  if (!expected.length && objectNames.includes('audiobook.source-chapters.json')) {
    try {
      const manifest = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, 'audiobook.source-chapters.json', namespace)).toString('utf8'));
      expected = manifest.chapters.filter((c: { text: string }) => c.text.trim()).map((c: { index: number }) => c.index);
    } catch (error) { if (!isMissingBlobError(error)) throw error; }
  }
  // Historical books lack a manifest. Retained originals/failures expose gaps,
  // including the last failed chapter, without re-extracting the PDF.
  if (!expected.length) {
    const indices = objectNames.flatMap(name => { const m = /^(\d{4,6})__/.exec(name); return m ? [Number(m[1]) - 1] : []; });
    const max = Math.max(-1, ...indices);
    expected = Array.from({ length: max + 1 }, (_, i) => i);
  }
  const records = await db.select({ chapterIndex: audiobookChapters.chapterIndex, filePath: audiobookChapters.filePath }).from(audiobookChapters)
    .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId)));
  const audio = new Set(listChapterObjects(objectNames).map(c => c.index));
  const recorded = records.filter((c: { chapterIndex: number; filePath: string }) => audio.has(c.chapterIndex) && objectNames.includes(c.filePath)).map((c: { chapterIndex: number }) => c.chapterIndex);
  const omitted = Array.isArray(settings.omittedChapterIndexes) ? settings.omittedChapterIndexes : [];
  const missing = missingAudiobookChapters(expected, recorded, omitted);
  const activeReviewChapterIndexes: number[] = [];
  for (const name of objectNames.filter(n => /^\d{4,6}__pronunciation_failure\.json$/.test(n))) {
    const index = Number(name.split('__')[0]) - 1;
    if (!recorded.includes(index)) { activeReviewChapterIndexes.push(index); continue; }
    const failure = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, name, namespace)).toString('utf8'));
    let recovered = false;
    try {
      const receipt = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, `${String(index + 1).padStart(4, '0')}__recording_state.json`, namespace)).toString('utf8'));
      recovered = typeof receipt.recordedAt === 'number' && receipt.recordedAt >= (failure.createdAt ?? 0);
    } catch (error) { if (!isMissingBlobError(error)) throw error; }
    if (!recovered) activeReviewChapterIndexes.push(index);
  }

  return { expectedChapterIndexes: expected, missingChapterIndexes: missing, recordedChapterIndexes: recorded,
    omittedChapterIndexes: omitted as number[], activeReviewChapterIndexes, complete: expected.length > 0 && missing.length === 0 && activeReviewChapterIndexes.length === 0 };
}

export async function assertAudiobookComplete(bookId: string, userId: string, namespace: string | null, names?: string[]) {
  const state = await readAudiobookCompleteness(bookId, userId, namespace, names);
  if (state.activeReviewChapterIndexes.length) throw new Error(`Chapter content review is required before full-book compilation: ${state.activeReviewChapterIndexes.length} chapters.`);
  if (!state.complete) throw new Error(`Incomplete audiobook: ${state.missingChapterIndexes.length} required chapter recordings are missing. Retry missing chapters before full-book compilation.`);
  return state;
}
