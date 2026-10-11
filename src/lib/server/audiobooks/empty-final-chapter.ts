import { createHash } from 'node:crypto';
import { getAudiobookObjectBuffer, isMissingBlobError } from './blobstore';

export const EMPTY_FINAL_CHAPTER_RECEIPT = 'audiobook.empty-final-chapter-omission.json';
export type EmptyFinalChapterCandidate = { chapterIndex: number; snapshotHash: string };

/** Missing text is not proof of emptiness. This candidate requires explicit owner confirmation. */
export async function readEmptyFinalChapterCandidate(input: {
  bookId: string; userId: string; namespace: string | null; generationJobId?: string;
  expected: number[]; missing: number[]; recorded: number[]; review: number[];
  chapterRecordIndexes: number[];
  objectNames: string[]; sourceManifest: Buffer | null;
}): Promise<EmptyFinalChapterCandidate | null> {
  const { expected, missing, recorded, objectNames } = input;
  if (!expected.length || expected.some(index => !Number.isSafeInteger(index) || index < 0)
      || missing.length !== 1 || !recorded.length || input.review.length) return null;
  const chapterIndex = Math.max(...expected);
  if (missing[0] !== chapterIndex || input.chapterRecordIndexes.some(index => index >= chapterIndex)) return null;
  const prefix = `${String(chapterIndex + 1).padStart(4, '0')}__`;
  const textNames = ['original.txt', 'text.txt'].map(suffix => prefix + suffix);
  // Audio, diagnostics or any other chapter artifact require normal review/recovery.
  if (objectNames.some(name => {
    const match = /^(\d{1,6})__/u.exec(name);
    const index = match ? Number(match[1]) - 1 : -1;
    return index > chapterIndex || (index === chapterIndex && !textNames.includes(name));
  })) return null;
  if (input.sourceManifest) {
    try {
      const manifest = JSON.parse(input.sourceManifest.toString('utf8'));
      if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.chapters)) return null;
      for (const chapter of manifest.chapters) {
        if (!chapter || !Number.isSafeInteger(chapter.index) || typeof chapter.text !== 'string') return null;
        if (chapter.index === chapterIndex && (chapter.text.trim()
            || (chapter.cleanupText !== undefined && (typeof chapter.cleanupText !== 'string' || chapter.cleanupText.trim())))) return null;
        if (chapter.index > chapterIndex) return null;
      }
    } catch { return null; }
  }
  const texts: Array<string | null> = [];
  for (const name of textNames) {
    try {
      const text = (await getAudiobookObjectBuffer(input.bookId, input.userId, name, input.namespace)).toString('utf8');
      if (text.trim()) return null;
      texts.push(text);
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      texts.push(null);
    }
  }
  const snapshotHash = createHash('sha256').update(JSON.stringify({
    bookId: input.bookId, userId: input.userId, generationJobId: input.generationJobId,
    expected: [...new Set(expected)].sort((a, b) => a - b),
    sourceManifest: input.sourceManifest?.toString('utf8') ?? null, texts,
  })).digest('hex');
  return { chapterIndex, snapshotHash };
}

export function isConfirmedEmptyFinalChapter(value: unknown, candidate: EmptyFinalChapterCandidate | null, userId: string): boolean {
  if (!candidate || !value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  return receipt.schemaVersion === 1 && receipt.reason === 'user_confirmed_empty_final_chapter'
    && receipt.chapterIndex === candidate.chapterIndex && receipt.snapshotHash === candidate.snapshotHash
    && receipt.confirmedBy === userId && typeof receipt.confirmedAt === 'number'
    && Number.isFinite(receipt.confirmedAt) && receipt.confirmedAt > 0;
}
