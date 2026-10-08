"use client";
import { useState } from 'react';
import type { SmartAudioReviewFlag } from '@/types/document-settings';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
export function ReviewIssuesPanel({ chapterIndex, flags, error, chapterExists, retryingId, onRetry, onResolve, onDetails, onAllLogs, onRefresh, needsAttention, onChapterDetails, pronunciationCount = 0, pronunciationReviewRequired = false, onPronunciationReview }: {
  pronunciationCount?: number; pronunciationReviewRequired?: boolean; onPronunciationReview?: () => void;
  needsAttention?: boolean; onChapterDetails?: () => void;
  chapterIndex: number; flags: SmartAudioReviewFlag[]; error: string | null; chapterExists: (index: number) => boolean;
  retryingId: string | null; onRetry: (flag: SmartAudioReviewFlag) => void; onResolve: (id: string) => void;
  onDetails: (flag: SmartAudioReviewFlag) => void; onAllLogs: () => void; onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const current = flags.filter(f => f.chapterIndex === chapterIndex);
  const others = flags.filter(f => f.chapterIndex !== chapterIndex);
  const renderIssue = (flag: SmartAudioReviewFlag) => <article key={flag.id} className="rounded border border-line bg-surface p-3 text-xs text-foreground">
    <p className="font-semibold">Chapter {flag.chapterIndex + 1}{flag.speaker ? ` · ${flag.speaker}` : ''}</p>
    {flag.kind && <p className="mt-1 capitalize">{flag.kind.replaceAll('-', ' ')}</p>}
    {flag.sourceText && <p className="mt-1 line-clamp-2 text-soft">“{flag.sourceText}”</p>}
    {flag.reason && <p className="mt-1 text-soft">Reason: {flag.reason}</p>}
    <div className="mt-2 flex gap-2">
      <Button size="sm" variant="outline" onClick={() => onRetry(flag)} disabled={!chapterExists(flag.chapterIndex) || retryingId === flag.id}>{retryingId === flag.id ? 'Queuing…' : 'Retry'}</Button>
      <Button size="sm" variant="ghost" onClick={() => onResolve(flag.id)}>Resolve</Button>
      <Button size="sm" variant="ghost" onClick={() => onDetails(flag)}>Details</Button>
    </div>
  </article>;
  return <section aria-label="Review issues" className="flex-none border-b border-line-soft bg-surface-sunken">
    <div className="flex min-h-9 items-center justify-between gap-2 px-3 text-xs text-foreground">
      <p>{error ? 'Review issues could not be refreshed' : current.length ? `⚠ ${current.length} ${current.length === 1 ? 'issue' : 'issues'} in this chapter · ${flags.length} total` : needsAttention ? `⚠ This chapter needs review${others.length ? ` · ${others.length} issues elsewhere` : ''}` : `✓ No issues in this chapter${others.length ? ` · ${others.length} elsewhere` : ''}`}</p>
      <Button variant="ghost" size="sm" aria-expanded={expanded} aria-controls="review-issues-content" onClick={() => setExpanded(v => !v)}>{current.length || needsAttention ? 'Review Issues' : 'All Issues'} <span aria-hidden="true" className="ml-1">{expanded ? '▴' : '▾'}</span></Button>
    </div>
    {pronunciationReviewRequired && <div className="flex items-center justify-between gap-2 border-t border-warning bg-warning-wash px-3 py-1 text-xs text-foreground">
      <p><span className="font-semibold text-warning">Pronunciation needs review</span>{pronunciationCount ? ` · ${pronunciationCount} ${pronunciationCount === 1 ? 'finding' : 'findings'} in this chapter` : ' · Scan saved text and review proposals'}</p>
      <Button size="sm" variant="ghost" onClick={onPronunciationReview}>Review pronunciation fixes</Button>
    </div>}
    {expanded && <div id="review-issues-content" className="max-h-64 overflow-y-auto border-t border-line-soft p-3">
      <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-foreground">Review Issues</h2><div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onAllLogs}>View All Error Logs</Button>
        <IconButton onClick={onRefresh} aria-label="Refresh review issues" title="Refresh review issues">↻</IconButton>
      </div></div>
      {error && <p role="alert" className="mb-2 text-xs text-danger">{error}</p>}
      {needsAttention && !current.length && <article className="mb-2 rounded border border-line bg-surface p-3 text-xs text-foreground">
        <h3 className="font-semibold">Current Chapter</h3>
        <p className="my-2">This chapter needs a recording or source-text check. Inspect its diagnostics, then edit or re-record the chapter.</p>
        <Button size="sm" variant="outline" onClick={onChapterDetails}>Details</Button>
      </article>}
      {current.length > 0 && <><h3 className="mb-2 text-xs font-semibold uppercase text-soft">Current Chapter</h3><div className="grid gap-2 lg:grid-cols-2">{current.map(renderIssue)}</div></>}
      {others.length > 0 && <div className="mt-3"><Button variant="ghost" size="sm" aria-expanded={showOthers} onClick={() => setShowOthers(v => !v)}>{showOthers ? 'Hide' : 'Show'} {others.length} other book issues</Button>
        {showOthers && <div className="mt-2 grid gap-2 lg:grid-cols-2">{others.map(renderIssue)}</div>}
      </div>}
      {!flags.length && !error && !needsAttention && !pronunciationReviewRequired && <p className="text-xs text-soft">No retained review issues.</p>}
    </div>}
  </section>;
}
