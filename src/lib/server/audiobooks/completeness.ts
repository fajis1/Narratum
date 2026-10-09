import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db';
import { audiobookJobs, audiobookChapters } from '@/db/schema';
import { getAudiobookObjectBuffer, isMissingBlobError, listAudiobookObjects } from './blobstore';
import { decodeChapterFileName } from './chapters';
import { createChapterOmissionEvidence, getChapterOmissionReason, isValidChapterOmissionEvidence } from './chapter-omissions';

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
  let sourceChapters: Array<{ index: number; title?: string; text: string; cleanupText?: string }> | null = null;
  if (objectNames.includes('audiobook.source-chapters.json')) {
    try {
      const manifest = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, 'audiobook.source-chapters.json', namespace)).toString('utf8'));
      if (manifest?.schemaVersion === 1 && Array.isArray(manifest.chapters)) {
        sourceChapters = manifest.chapters.filter((chapter: unknown): chapter is { index: number; title?: string; text: string; cleanupText?: string } => (
          Boolean(chapter) && typeof chapter === 'object'
          && Number.isInteger((chapter as { index?: unknown }).index)
          && typeof (chapter as { text?: unknown }).text === 'string'
          && ((chapter as { cleanupText?: unknown }).cleanupText === undefined || typeof (chapter as { cleanupText?: unknown }).cleanupText === 'string')
        ));
      }
    } catch (error) { if (!isMissingBlobError(error)) throw error; }
  }
  let expected: number[] = Array.isArray(settings.expectedChapterIndexes) ? settings.expectedChapterIndexes : [];
  if (!expected.length && sourceChapters) expected = sourceChapters.filter(c => c.text.trim()).map(c => c.index);
  // Historical books lack a manifest. Retained originals/failures expose gaps,
  // including the last failed chapter, without re-extracting the PDF.
  if (!expected.length) {
    const indices = objectNames.flatMap(name => { const m = /^(\d{4,6})__/.exec(name); return m ? [Number(m[1]) - 1] : []; });
    const max = Math.max(-1, ...indices);
    expected = Array.from({ length: max + 1 }, (_, i) => i);
  }
  const records = await db.select({ chapterIndex: audiobookChapters.chapterIndex, filePath: audiobookChapters.filePath, format: audiobookChapters.format }).from(audiobookChapters)
    .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId)));
  const recorded = records.filter((c: { chapterIndex: number; filePath: string; format: string }) => {
    const referenced = decodeChapterFileName(c.filePath);
    return objectNames.includes(c.filePath) && referenced?.index === c.chapterIndex && referenced.format === c.format;
  }).map((c: { chapterIndex: number }) => c.chapterIndex);
  const legacyOmitted = new Set<number>(Array.isArray(settings.omittedChapterIndexes)
    ? settings.omittedChapterIndexes.filter((index: unknown): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0)
    : []);
  let omissionEntries: unknown[] = [];
  try {
    const artifact = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, 'audiobook.omissions.json', namespace)).toString('utf8'));
    if (artifact?.schemaVersion === 1 && Array.isArray(artifact.entries)) omissionEntries = artifact.entries;
  } catch (error) { if (!isMissingBlobError(error)) throw error; }
  const evidenceByIndex = new Map<number, unknown>();
  for (const entry of omissionEntries) {
    const index = (entry as { chapterIndex?: unknown } | null)?.chapterIndex;
    if (Number.isInteger(index) && !evidenceByIndex.has(index as number)) evidenceByIndex.set(index as number, entry);
  }
  const verifiedOmissionIndexes: number[] = [];
  const invalidOmissionChapterIndexes: number[] = [];
  for (const index of new Set([...legacyOmitted, ...evidenceByIndex.keys()])) {
    const chapter = sourceChapters?.find(c => c.index === index);
    const entry = evidenceByIndex.get(index);
    const legacyReason = chapter ? getChapterOmissionReason(chapter) : null;
    const valid = Boolean(chapter && (entry
      ? isValidChapterOmissionEvidence(entry, chapter)
      : legacyOmitted.has(index) && legacyReason && createChapterOmissionEvidence(chapter, legacyReason)));
    // Old jobs stored only indexes. Accept them conservatively only when their
    // pinned source independently proves empty content or marked structural end matter.
    if (valid) verifiedOmissionIndexes.push(index);
    else if (expected.includes(index)) invalidOmissionChapterIndexes.push(index);
  }
  const omitted = verifiedOmissionIndexes;
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
    omittedChapterIndexes: omitted, invalidOmissionChapterIndexes, activeReviewChapterIndexes,
    complete: expected.length > 0 && missing.length === 0 && activeReviewChapterIndexes.length === 0 };
}

export async function assertAudiobookComplete(bookId: string, userId: string, namespace: string | null, names?: string[]) {
  const state = await readAudiobookCompleteness(bookId, userId, namespace, names);
  if (state.activeReviewChapterIndexes.length) throw new Error(`Chapter content review is required before full-book compilation: ${state.activeReviewChapterIndexes.length} chapters.`);
  if (!state.complete) {
    const invalidOmissions = state.invalidOmissionChapterIndexes.length;
    throw new Error(`Incomplete audiobook: ${state.missingChapterIndexes.length} required chapter recordings are missing.${invalidOmissions ? ` ${invalidOmissions} saved chapter omission(s) lack valid source evidence and must be retried or reviewed.` : ''} Retry missing chapters before full-book compilation.`);
  }
  return state;
}
