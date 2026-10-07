import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { chapterNeedsReview as isChapterNeedingReview, filterAndSortChapters } from '@/components/audiobooks/review/review-chapters';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewChapterList } from '@/components/audiobooks/review/ReviewChapterList';
import type { TTSAudiobookChapter } from '@/types/tts';
import type { SmartAudioReviewFlag } from '@/types/document-settings';

const readSource = (relativePath: string) => fs.readFileSync(
  path.join(process.cwd(), relativePath),
  'utf8',
);

describe('Audiobook Chapter Review & Filtering Logic', () => {
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
      { id: 'flag-1', chapterIndex: 3, kind: 'cloud-tts-failed', reason: 'Excessive pauses detected', timestampMs: 0, createdAt: 123456 },
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

  test('chapter list renders real filter/search/sort controls and status badges without row log buttons', () => {
    const html = renderToStaticMarkup(createElement(ReviewChapterList, {
      chapters: [{ index: 0, title: 'Review chapter', format: 'mp3', hasRejected: true }],
      visible: [{ index: 0, title: 'Review chapter', format: 'mp3', hasRejected: true }], selectedIndex: 0,
      reviewCount: 1, filter: 'all', onFilter: () => {}, search: '', onSearch: () => {}, sort: 'default', onSort: () => {},
      onSelect: () => {}, needsReview: isChapterNeedingReview, hasFlag: () => false,
    }));
    expect(html).toContain('Chapter filter');
    expect(html).toContain('Search chapters');
    expect(html).toContain('Order: Review First');
    expect(html).toContain('Needs re-recording');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain('Log');
  });

  test('failure-log route retrieves chapter failure JSON, job error, and review flags', () => {
    const failureLogSource = readSource('src/app/api/audiobook/failure-log/route.ts');
    expect(failureLogSource).toContain('__pronunciation_failure.json');
    expect(failureLogSource).toContain('audiobookJobs');
    expect(failureLogSource).toContain('documentSettings');
    expect(failureLogSource).toContain('normalizeSmartAudioReviewFlags');
    expect(failureLogSource).toContain('listAudiobookObjects');
    expect(failureLogSource).toContain('getAudiobookObjectBuffer');
    expect(failureLogSource).toContain('hasDirectorDiagnostic');
    expect(failureLogSource).toContain('drama-director-failure-chapter-');
  });

  test('ChapterErrorLogModal component categorizes errors and provides diagnostics', () => {
    const modalSource = readSource('src/components/audiobooks/ChapterErrorLogModal.tsx');
    const categorySource = readSource('src/lib/shared/audiobook-error-category.ts');
    expect(categorySource).toContain('Drama Director Validation Failure');
    expect(categorySource).toContain('Content Safety Filter Block');
    expect(categorySource).toContain('Upstream Quota or Rate Limit');
    expect(categorySource).toContain('Audio Synthesis or Remux Failure');
    expect(modalSource).toContain('navigator.clipboard.writeText');
    expect(modalSource).toContain('Copy Diagnostic Log');
    expect(modalSource).toContain('{failure.chapterIndex != null && failure.hasDirectorDiagnostic && (');
    expect(modalSource).toContain('categorizeErrors(failure.errors, effectiveJobError, failure.hasDirectorDiagnostic)');
    expect(modalSource).toContain('failure.hasProviderDiagnostic');
    expect(modalSource).toContain('No retained Gemini response is available for this failure');
  });

  test('chapter re-record route retains failed Gemini Director responses', () => {
    const chapterSource = readSource('src/app/api/audiobook/chapter/route.ts');
    expect(chapterSource).toContain('drama-director-failure-chapter-');
    expect(chapterSource).toContain('audiobook.chapter.drama_director_diagnostic_persist_failed');
    expect(chapterSource).toContain('attempts');
  });

  test('Cloud Drama review persistence replaces stale automated flags for the chapter', () => {
    const reviewSource = readSource('src/lib/server/audiobooks/cloud-drama-review.ts');
    expect(reviewSource).toContain('CLOUD_DRAMA_REVIEW_KINDS');
    expect(reviewSource).toContain('flag.chapterIndex === input.chapterIndex');
    expect(reviewSource).not.toContain('if (!input.flags.length) return');
  });

  test('Gemini review uses persisted speaker turns while retaining the full-text editor', () => {
    const listenSource = readSource('src/app/(app)/listen/[bookId]/page.tsx');
    const reviewSource = readSource('src/components/audiobooks/GeminiDramaSpeakerReview.tsx');
    expect(listenSource).toContain('<GeminiDramaSpeakerReview');
    expect(listenSource).toContain("'Speaker turns' : 'Edit full text'");
    expect(reviewSource).toContain('getMatchingDramaSpeakerReview(savedReview, chapterText)');
    expect(reviewSource).toContain('review.segments.map');
    expect(reviewSource).toContain('Prepare speaker review');
    expect(reviewSource).toContain('/api/audiobook/characters/preview');
  });

  test('JobsInlineView connects error log modal to failed background jobs', () => {
    const inlineJobs = readSource('src/components/doclist/views/JobsInlineView.tsx');
    expect(inlineJobs).toContain('View Error Log & Diagnostics');
    expect(inlineJobs).toContain('📋 Error Log');
    expect(inlineJobs).toContain('<ChapterErrorLogModal');
    expect(inlineJobs).toContain('Review Chapters');
  });

  test('ListenPage provides error log triggers and integrates ChapterErrorLogModal', () => {
    const listenSource = readSource('src/app/(app)/listen/[bookId]/page.tsx');
    expect(listenSource).toContain('setErrorLogModalChapter');
    expect(listenSource).toContain('onErrorLog=');
    expect(listenSource).toContain('onAllLogs=');
    expect(listenSource).not.toContain('📋 Log');
    expect(listenSource).toContain('<ChapterErrorLogModal');
  });
});
