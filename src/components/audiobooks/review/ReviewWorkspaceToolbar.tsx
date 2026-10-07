import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Toolbar } from '@/components/ui/toolbar';
import { ReviewDesktopPaneSelector, type ReviewPane } from './ReviewPaneSelector';
export function ReviewWorkspaceToolbar({ panes, onToggle, drama, onDrama, onMobileAudio, onClean, chapterTools, dirty, speakerDirty, busy, onSave }: {
  panes: Record<ReviewPane, boolean>; onToggle: (pane: ReviewPane) => void; drama: boolean; onDrama: () => void;
  onMobileAudio: () => void; onClean: () => void; chapterTools: ReactNode;
  dirty: boolean; speakerDirty: boolean; busy: boolean; onSave: () => void;
}) {
  return <Toolbar className="static z-20 flex-none" aria-label="Chapter workspace tools">
    <ReviewDesktopPaneSelector panes={panes} onToggle={onToggle} />
    {drama && <Button variant="outline" className="hidden lg:inline-flex" onClick={onDrama}>Audio Drama Studio</Button>}
    <Button variant="outline" className="min-h-11 md:hidden" onClick={onMobileAudio}>Review Audio</Button>
    <Button variant="outline" className="min-h-11 md:min-h-8" onClick={onClean} disabled={busy}><span className="xl:hidden">AI Clean…</span><span className="hidden xl:inline">AI Clean Chapter…</span></Button>
    <div className="ml-auto flex shrink-0 items-center gap-2">{chapterTools}
      {dirty && <Button variant="primary" className={`hidden md:min-h-8 ${speakerDirty ? 'md:hidden' : 'md:inline-flex'}`} disabled={busy} onClick={onSave}>{busy ? 'Re-recording…' : 'Save & Re-record'}</Button>}
    </div>
  </Toolbar>;
}
