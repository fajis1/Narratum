import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function ReviewHeader({ title, position, needsReview, dirty, recording, processing, filtered, canPrevious, canNext, onPrevious, onNext, bookTools }: {
  title: string; position: string; needsReview: boolean; dirty: boolean; recording: boolean; processing: boolean;
  filtered: boolean; canPrevious: boolean; canNext: boolean; onPrevious: () => void; onNext: () => void; bookTools: ReactNode;
}) {
  return <header className="flex flex-none items-center justify-between gap-2 border-b border-line-soft bg-surface px-3 py-2" aria-label="Chapter review">
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
        <h1 className="min-w-0 truncate text-base font-semibold text-foreground" title={title}>Review: {title}</h1>
        {needsReview && <span className="rounded border border-line bg-surface-sunken px-1.5 text-xs text-foreground">Needs review</span>}
        {dirty && <span className="rounded border border-accent-line bg-accent-wash px-1.5 text-xs text-accent">Unsaved changes</span>}
        {recording ? <span role="status" className="text-xs text-soft">Re-recording…</span> : processing && <span role="status" className="text-xs text-soft">Processing…</span>}
      </div>
      <p className="text-xs text-soft">{position}</p>
    </div>
    <nav aria-label="Chapter navigation" className="flex shrink-0 items-center gap-1">
      <Button variant="ghost" onClick={onPrevious} disabled={!canPrevious} className="min-h-11 px-2 md:min-h-8" aria-label={filtered ? 'Previous chapter needing review' : 'Previous chapter'} title="Previous chapter">
        <span aria-hidden="true">←</span><span className="ml-1 hidden lg:inline">Previous</span>
      </Button>
      <Button variant="ghost" onClick={onNext} disabled={!canNext} className="min-h-11 px-2 md:min-h-8" aria-label={filtered ? 'Next chapter needing review' : 'Next chapter'} title="Next chapter">
        <span className="mr-1 hidden lg:inline">Next</span><span aria-hidden="true">→</span>
      </Button>
      {bookTools}
    </nav>
  </header>;
}
