"use client";
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ToolbarGroup, ToolbarSegment } from '@/components/ui/toolbar';
export type ReviewPane = 'chapters' | 'original' | 'edit';
export function ReviewDesktopPaneSelector({ panes, onToggle }: { panes: Record<ReviewPane, boolean>; onToggle: (pane: ReviewPane) => void }) {
  return <div className="hidden shrink-0 items-center gap-2 md:flex">
    <span className="text-xs text-soft">Layout:</span>
    <ToolbarGroup role="group" aria-label="Desktop pane visibility">
      {(['chapters', 'original', 'edit'] as const).map(pane => <ToolbarSegment key={pane} active={panes[pane]} aria-pressed={panes[pane]} onClick={() => onToggle(pane)} className="min-h-8 px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {pane === 'chapters' ? 'List' : pane === 'original' ? 'Original' : 'Edit'}
      </ToolbarSegment>)}
    </ToolbarGroup>
  </div>;
}
export function ReviewMobilePaneSelector({ value, onChange }: { value: ReviewPane; onChange: (pane: ReviewPane) => void }) {
  return <div className="flex-none border-b border-line-soft px-3 py-1 md:hidden">
    <SegmentedControl value={value} onChange={onChange} ariaLabel="Mobile workspace" options={[
      { value: 'chapters', label: 'Chapters' }, { value: 'original', label: 'Original' }, { value: 'edit', label: 'Edit' },
    ]} className="grid-cols-3 [&_button]:min-h-11" />
  </div>;
}
