"use client";
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
export interface ReviewChapter {
  index: number; title: string; format: string; hasAudio?: boolean; hasRejected?: boolean;
  hasFailure?: boolean; needsReview?: boolean; isEmptyText?: boolean; status?: string;
}
export function ReviewChapterList({ chapters, visible, selectedIndex, reviewCount, filter, onFilter, search, onSearch, sort, onSort, onSelect, needsReview, hasFlag, selectedContent }: {
  chapters: ReviewChapter[]; visible: ReviewChapter[]; selectedIndex: number; reviewCount: number;
  filter: 'all' | 'needs_review'; onFilter: (filter: 'all' | 'needs_review') => void;
  search: string; onSearch: (search: string) => void; sort: 'default' | 'review_first'; onSort: (sort: 'default' | 'review_first') => void;
  onSelect: (chapterIndex: number) => void; needsReview: (chapter: ReviewChapter) => boolean; hasFlag: (chapterIndex: number) => boolean; selectedContent?: ReactNode;
}) {
  return <>
    <div className="flex-none space-y-2 border-b border-line-soft bg-surface-raised p-3">
      <h2 className="text-sm font-semibold text-foreground">Chapters</h2>
      <div className="flex gap-1" role="group" aria-label="Chapter filter">
        <Button size="sm" variant={filter === 'all' ? 'outline' : 'ghost'} aria-pressed={filter === 'all'} onClick={() => onFilter('all')}>All ({chapters.length})</Button>
        <Button size="sm" variant={filter === 'needs_review' ? 'outline' : 'ghost'} aria-pressed={filter === 'needs_review'} onClick={() => onFilter('needs_review')}>Needs Review ({reviewCount})</Button>
      </div>
      <div className="relative"><input aria-label="Search chapters" placeholder="Search chunk or title…" value={search} onChange={e => onSearch(e.target.value)} className="h-8 w-full rounded border border-line bg-surface px-2 pr-8 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        {search && <IconButton size="sm" aria-label="Clear search" title="Clear search" onClick={() => onSearch('')} className="absolute right-0 top-0">×</IconButton>}
      </div>
      <select aria-label="Sort chapters" value={sort} onChange={e => onSort(e.target.value as 'default' | 'review_first')} className="h-8 w-full rounded border border-line bg-surface px-2 text-xs text-foreground focus-visible:ring-2 focus-visible:ring-accent"><option value="default">Order: Chunk #</option><option value="review_first">Order: Review First</option></select>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {!visible.length && <div className="p-3 text-xs text-soft"><p>{filter === 'needs_review' ? 'No chapters need manual review.' : 'No chapters matched your search.'}</p>{filter === 'needs_review' && <Button size="sm" variant="ghost" onClick={() => onFilter('all')}>Show all chapters</Button>}</div>}
      {visible.map(chapter => <div key={chapter.index} className="mb-1">
        <button type="button" aria-current={selectedIndex === chapter.index ? 'true' : undefined} onClick={() => onSelect(chapter.index)} className={`w-full rounded border p-3 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${selectedIndex === chapter.index ? 'border-accent-line bg-accent-wash text-foreground' : needsReview(chapter) ? 'border-line bg-surface-sunken text-foreground hover:bg-accent-wash' : 'border-transparent text-soft hover:bg-surface-raised'}`}>
          <span className="block font-medium">Chunk {chapter.index + 1}</span><span className="mt-1 block text-xs">{chapter.title}</span>
          <span className="mt-1 flex flex-wrap gap-1 text-[10px]">
            {(chapter.hasRejected || chapter.hasFailure || chapter.status === 'error') && <span className="rounded border border-line bg-surface px-1">Needs re-recording</span>}
            {chapter.isEmptyText && <span className="rounded border border-line bg-surface px-1">Empty text</span>}
            {(hasFlag(chapter.index) || chapter.needsReview) && <span className="rounded border border-line bg-surface px-1">Review issue</span>}
            {chapter.hasAudio === false && !chapter.hasRejected && <span className="rounded border border-line bg-surface px-1">Pending audio</span>}
          </span>
        </button>
        {selectedIndex === chapter.index && selectedContent}
      </div>)}
    </div>
  </>;
}
