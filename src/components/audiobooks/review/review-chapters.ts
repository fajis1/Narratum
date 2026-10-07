import type { SmartAudioReviewFlag } from '@/types/document-settings';
import type { ReviewChapter } from './ReviewChapterList';

export function chapterNeedsReview(chapter: Partial<ReviewChapter>, flags: SmartAudioReviewFlag[] = []): boolean {
  return Boolean(chapter.hasRejected || chapter.hasFailure || chapter.needsReview || chapter.isEmptyText
    || chapter.hasAudio === false || chapter.status === 'error' || flags.some(f => f.chapterIndex === chapter.index));
}

export function filterAndSortChapters<T extends { index: number; title: string } & Partial<ReviewChapter>>(chapters: T[], filter: 'all' | 'needs_review', sort: 'default' | 'review_first', search = '', flags: SmartAudioReviewFlag[] = []): T[] {
  const query = search.trim().toLowerCase();
  return chapters.filter(c => (!query || `chunk ${c.index + 1}`.includes(query) || (c.title || '').toLowerCase().includes(query))
    && (filter !== 'needs_review' || chapterNeedsReview(c, flags)))
    .sort((a, b) => (sort === 'review_first' ? Number(chapterNeedsReview(b, flags)) - Number(chapterNeedsReview(a, flags)) : 0) || a.index - b.index);
}
