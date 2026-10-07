import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { bookToolSections } from '@/components/audiobooks/review/ReviewBookMenu';
import { chapterToolSections } from '@/components/audiobooks/review/ReviewChapterMenu';
import { ReviewWorkspaceToolbar } from '@/components/audiobooks/review/ReviewWorkspaceToolbar';
import { ReviewMobilePaneSelector } from '@/components/audiobooks/review/ReviewPaneSelector';
import { ReviewIssuesPanel } from '@/components/audiobooks/review/ReviewIssuesPanel';
import { chapterNeedsReview, filterAndSortChapters } from '@/components/audiobooks/review/review-chapters';

describe('review command scopes', () => {
  test('book sections invoke the original callbacks and isolate force recording as danger', () => {
    const callbacks = { onScan: vi.fn(), onReviewChanges: vi.fn(), onFixAll: vi.fn(), onBatchRefine: vi.fn(), onRecordModified: vi.fn(), onExport: vi.fn(), onForceRecord: vi.fn() };
    const sections = bookToolSections({ ...callbacks, fixing: false, rebuilding: false, empty: false, showReviewChanges: true });
    expect(sections.map(s => s.title)).toEqual(['Review', 'Book Text', 'Recording', 'Export', 'Danger']);
    sections.flatMap(s => s.actions).forEach(a => a.onClick());
    Object.values(callbacks).forEach(callback => expect(callback).toHaveBeenCalledOnce());
    expect(sections.flatMap(s => s.actions).filter(a => a.danger).map(a => a.label)).toEqual(['Force Re-record All…']);
    expect(sections.flatMap(s => s.actions).some(a => /Dictionary|in this chapter|Re-record chapter/.test(a.label))).toBe(false);
  });
  test('chapter tools exclude whole-book operations; logs and clean re-record are conditional', () => {
    const callbacks = { onDictionary: vi.fn(), onAbbreviation: vi.fn(), onFixAbbreviations: vi.fn(), onSettings: vi.fn(), onErrorLog: vi.fn(), onRecord: vi.fn() };
    const sections = chapterToolSections({ ...callbacks, hasError: true, dirty: false, busy: false });
    sections.flatMap(s => s.actions).forEach(a => a.onClick());
    Object.values(callbacks).forEach(callback => expect(callback).toHaveBeenCalledOnce());
    expect(sections.flatMap(s => s.actions).some(a => /All|Batch|Audiobookshelf|Modified Chapters/.test(a.label))).toBe(false);
    const hidden = chapterToolSections({ ...callbacks, hasError: false, dirty: true, busy: false }).flatMap(s => s.actions).filter(a => a.hidden).map(a => a.label);
    expect(hidden).toEqual(['View error log', 'Re-record chapter']);
  });
  test('active batch review next step is not duplicated in Book Tools', () => {
    const noop = () => {};
    const sections = bookToolSections({ onScan: noop, onReviewChanges: noop, onFixAll: noop, onBatchRefine: noop, onRecordModified: noop, onExport: noop, onForceRecord: noop, fixing: false, rebuilding: false, empty: false, showReviewChanges: false });
    expect(sections[0].actions.find(a => a.label === 'Review AI Changes')?.hidden).toBe(true);
  });
});

describe('review workspace presentation', () => {
  const toolbar = (dirty: boolean) => renderToStaticMarkup(createElement(ReviewWorkspaceToolbar, {
    panes: { chapters: true, original: true, edit: true }, onToggle: () => {}, drama: false, onDrama: () => {}, onMobileAudio: () => {}, onClean: () => {}, chapterTools: null, dirty, speakerDirty: false, busy: false, onSave: () => {},
  }));
  test('desktop exposes three independently pressed pane buttons', () => {
    const html = toolbar(false);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain('Save &amp; Re-record');
  });
  test('dirty chapter has exactly one primary save action', () => {
    const html = toolbar(true);
    expect(html.match(/Save &amp; Re-record/g)).toHaveLength(1);
    expect(html.match(/bg-accent text-background/g)).toHaveLength(1);
  });
  test('mobile has exactly one selected workspace', () => {
    const html = renderToStaticMarkup(createElement(ReviewMobilePaneSelector, { value: 'edit', onChange: () => {} }));
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });
  test('issues remain compact/collapsed and report current chapter before book totals', () => {
    const html = renderToStaticMarkup(createElement(ReviewIssuesPanel, {
      chapterIndex: 2, flags: [{ id: 'other', chapterIndex: 0, kind: 'cloud-tts-failed', reason: 'Other reason', createdAt: 1, timestampMs: 0 }, { id: 'current', chapterIndex: 2, kind: 'cloud-tts-failed', reason: 'Current reason', createdAt: 1, timestampMs: 0 }], error: null, chapterExists: () => true, retryingId: null, onRetry: () => {}, onResolve: () => {}, onDetails: () => {}, onAllLogs: () => {}, onRefresh: () => {},
    }));
    expect(html).toContain('1 issue in this chapter · 2 total');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Other reason');
    expect(html).not.toContain('Current reason');
  });
  test('real chapter model includes failure artifacts and preserves sparse identifiers', () => {
    const chapters = [{ index: 9, title: 'Nine', format: 'mp3', hasFailure: true }, { index: 2, title: 'Two', format: 'mp3' }];
    expect(chapterNeedsReview(chapters[0])).toBe(true);
    expect(filterAndSortChapters(chapters, 'needs_review', 'default').map(c => c.index)).toEqual([9]);
    expect(chapters.map(c => c.index)).toEqual([9, 2]);
  });
});
