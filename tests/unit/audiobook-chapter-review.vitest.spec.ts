import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { TTSAudiobookChapter } from '@/types/tts';
import type { SmartAudioReviewFlag } from '@/types/document-settings';

const readSource = (relativePath: string) => fs.readFileSync(
  path.join(process.cwd(), relativePath),
  'utf8',
);

describe('Audiobook Chapter Review & Filtering Logic', () => {
  // Simulates the client-side helper function used in ListenPage
  function isChapterNeedingReview(
    chap: Partial<TTSAudiobookChapter> & { hasAudio?: boolean; hasRejected?: boolean; needsReview?: boolean },
    reviewFlags: SmartAudioReviewFlag[] = [],
  ): boolean {
    return Boolean(
      chap.hasRejected ||
      chap.needsReview ||
      chap.isEmptyText ||
      chap.hasAudio === false ||
      chap.status === 'error' ||
      reviewFlags.some((f) => f.chapterIndex === chap.index)
    );
  }

  function filterAndSortChapters(
    chapters: Array<TTSAudiobookChapter>,
    filter: 'all' | 'needs_review',
    sort: 'default' | 'review_first',
    search = '',
    reviewFlags: SmartAudioReviewFlag[] = [],
  ): Array<TTSAudiobookChapter> {
    let list = [...chapters];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((c) => {
        const chunkLabel = `chunk ${c.index + 1}`.toLowerCase();
        const titleLabel = (c.title || '').toLowerCase();
        return chunkLabel.includes(q) || titleLabel.includes(q);
      });
    }

    if (filter === 'needs_review') {
      list = list.filter((c) => isChapterNeedingReview(c, reviewFlags));
    }

    if (sort === 'review_first') {
      list.sort((a, b) => {
        const aNeeds = isChapterNeedingReview(a, reviewFlags) ? 1 : 0;
        const bNeeds = isChapterNeedingReview(b, reviewFlags) ? 1 : 0;
        if (bNeeds !== aNeeds) return bNeeds - aNeeds;
        return a.index - b.index;
      });
    } else {
      list.sort((a, b) => a.index - b.index);
    }

    return list;
  }

  const sampleChapters: TTSAudiobookChapter[] = [
    { index: 0, title: 'Introduction', format: 'mp3', status: 'completed', hasAudio: true, hasRejected: false, isEmptyText: false, needsReview: false },
    { index: 1, title: 'Chapter 1: The Beginning', format: 'mp3', status: 'completed', hasAudio: true, hasRejected: false, isEmptyText: false, needsReview: false },
    { index: 2, title: 'Chapter 2: The Fall', format: 'mp3', status: 'error', hasAudio: true, hasRejected: true, isEmptyText: false, needsReview: true },
    { index: 3, title: 'Chapter 3: The Journey', format: 'mp3', status: 'completed', hasAudio: true, hasRejected: false, isEmptyText: false, needsReview: false },
    { index: 4, title: 'Chapter 4: The Void', format: 'mp3', status: 'completed', hasAudio: true, hasRejected: false, isEmptyText: true, needsReview: true },
    { index: 5, title: 'Chapter 5: The Mountain', format: 'mp3', status: 'completed', hasAudio: true, hasRejected: false, isEmptyText: false, needsReview: false },
    { index: 6, title: 'Chapter 6: The Summit', format: 'mp3', status: 'pending', hasAudio: false, hasRejected: false, isEmptyText: false, needsReview: true },
    { index: 7, title: 'Chapter 7: The Abyss', format: 'mp3', status: 'error', hasAudio: false, hasRejected: true, isEmptyText: false, needsReview: true },
  ];

  test('correctly identifies chapters needing manual review', () => {
    expect(isChapterNeedingReview(sampleChapters[0])).toBe(false);
    expect(isChapterNeedingReview(sampleChapters[1])).toBe(false);
    // Chapter 2 has hasRejected: true
    expect(isChapterNeedingReview(sampleChapters[2])).toBe(true);
    // Chapter 4 has isEmptyText: true
    expect(isChapterNeedingReview(sampleChapters[4])).toBe(true);
    // Chapter 6 has hasAudio: false
    expect(isChapterNeedingReview(sampleChapters[6])).toBe(true);
    // Chapter 7 has hasRejected: true and status: error
    expect(isChapterNeedingReview(sampleChapters[7])).toBe(true);
  });

  test('identifies chapters with active Smart Audio review flags', () => {
    const flags: SmartAudioReviewFlag[] = [
      { id: 'flag-1', chapterIndex: 3, kind: 'pause-overflow', reason: 'Excessive pauses detected' },
    ];
    // Chapter 3 normally does not need review
    expect(isChapterNeedingReview(sampleChapters[3], [])).toBe(false);
    // With flag attached to chapterIndex 3, it requires review
    expect(isChapterNeedingReview(sampleChapters[3], flags)).toBe(true);
  });

  test('filters strictly to chapters requiring manual review', () => {
    const reviewOnly = filterAndSortChapters(sampleChapters, 'needs_review', 'default');
    // Chapters 2, 4, 6, 7 need review (4 total)
    expect(reviewOnly.map((c) => c.index)).toEqual([2, 4, 6, 7]);
    expect(reviewOnly).toHaveLength(4);
  });

  test('sorts chapters with review_first ordering while preserving relative chapter order', () => {
    const sorted = filterAndSortChapters(sampleChapters, 'all', 'review_first');
    // Review chapters (2, 4, 6, 7) should come first, followed by clean chapters (0, 1, 3, 5)
    expect(sorted.map((c) => c.index)).toEqual([2, 4, 6, 7, 0, 1, 3, 5]);
  });

  test('filters by search keyword across chunk number and chapter title', () => {
    const searchResultChunk = filterAndSortChapters(sampleChapters, 'all', 'default', 'chunk 5');
    // Chunk 5 is index 4 (1-based index)
    expect(searchResultChunk.map((c) => c.index)).toEqual([4]);

    const searchResultTitle = filterAndSortChapters(sampleChapters, 'all', 'default', 'Summit');
    expect(searchResultTitle.map((c) => c.index)).toEqual([6]);
  });

  test('combines search keyword and needs_review filter', () => {
    // Search for "The" within needs_review
    const result = filterAndSortChapters(sampleChapters, 'needs_review', 'default', 'The');
    expect(result.map((c) => c.index)).toEqual([2, 4, 6, 7]);

    // Search for "Abyss" within needs_review
    const abyss = filterAndSortChapters(sampleChapters, 'needs_review', 'default', 'Abyss');
    expect(abyss.map((c) => c.index)).toEqual([7]);
  });
});

describe('Audiobook Review Route & Component Contracts', () => {
  test('status route includes all chapter indices and review/rejection flags', () => {
    const statusSource = readSource('src/app/api/audiobook/status/route.ts');
    expect(statusSource).toContain('hasRejected');
    expect(statusSource).toContain('hasFailure');
    expect(statusSource).toContain('needsReview');
    expect(statusSource).toContain('hasAudio');
    expect(statusSource).toContain('allChapterIndices');
    expect(statusSource).toContain(`${'${oneBasedPrefix}'}rejected.txt`);
    expect(statusSource).toContain(`${'${oneBasedPrefix}'}pronunciation_failure.json`);
  });

  test('text route falls back to __rejected.txt when __text.txt is missing', () => {
    const textSource = readSource('src/app/api/audiobook/text/route.ts');
    expect(textSource).toContain(`${'${prefix}'}__rejected.txt`);
    expect(textSource).toContain(`${'${prefix}'}__text.txt`);
    expect(textSource).toContain(`${'${prefix}'}__original.txt`);
    expect(textSource).toContain("type === 'rejected'");
  });

  test('chapter route deletes rejection artifacts upon successful replacement recording', () => {
    const chapterSource = readSource('src/app/api/audiobook/chapter/route.ts');
    expect(chapterSource).toContain(`${'${chapterPrefix}'}rejected.txt`);
    expect(chapterSource).toContain(`${'${chapterPrefix}'}pronunciation_failure.json`);
    expect(chapterSource).toContain('deleteAudiobookObject');
  });

  test('Audiobookshelf modal wires onReviewChapters and offers review navigation when blocked', () => {
    const absModalSource = readSource('src/components/audiobooks/AudiobookshelfModal.tsx');
    expect(absModalSource).toContain('onReviewChapters?: () => void');
    expect(absModalSource).toContain('uploadError');
    expect(absModalSource).toContain('filter=needs_review');
    expect(absModalSource).toContain('Open & Filter Chapters Needing Review');
  });

  test('ListenPage left pane provides filter tabs, sort dropdown, and review search', () => {
    const listenSource = readSource('src/app/(app)/listen/[bookId]/page.tsx');
    expect(listenSource).toContain("setChapterFilter('needs_review')");
    expect(listenSource).toContain("chapterSort");
    expect(listenSource).toContain("Order: Review First");
    expect(listenSource).toContain("Search chunk or title...");
    expect(listenSource).toContain("Needs Re-recording");
    expect(listenSource).toContain("visibleChapters");
    expect(listenSource).toContain("onReviewChapters");
  });
});
