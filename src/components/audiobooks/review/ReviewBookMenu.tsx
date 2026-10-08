"use client";
import { ReviewMenu, type ReviewMenuSection } from './ReviewMenus';

export interface ReviewBookMenuProps {
  onScan: () => void; onReviewChanges: () => void; onFixAll: () => void;
  onBatchRefine: () => void; onRecordModified: () => void; onExport: () => void; onForceRecord: () => void;
  fixing: boolean; rebuilding: boolean; empty: boolean; showReviewChanges: boolean; dirty?: boolean; activeJob?: boolean; pronunciationAttention?: boolean;
}
export function bookToolSections(p: ReviewBookMenuProps): ReviewMenuSection[] {
  const reason = p.dirty ? "Save or discard this chapter’s changes first." : p.activeJob || p.fixing || p.rebuilding ? 'Wait for the current book operation to finish.' : undefined;
  const blocked = Boolean(reason);
  return [
    { title: 'Review', actions: [
      { label: 'Scan Pronunciation Issues', onClick: p.onScan, disabled: blocked, description: reason, attention: p.pronunciationAttention },
      { label: 'Review AI Changes', onClick: p.onReviewChanges, hidden: !p.showReviewChanges },
    ] },
    { title: 'Book Text', actions: [
      { label: p.fixing ? 'Fixing abbreviations…' : 'Fix All Abbreviations', onClick: p.onFixAll, description: reason, disabled: blocked || p.empty },
      { label: 'AI Batch Refine…', onClick: p.onBatchRefine, disabled: blocked, description: reason },
    ] },
    { title: 'Recording', actions: [{ label: p.rebuilding ? 'Scanning chapters…' : 'Re-record Modified Chapters', onClick: p.onRecordModified, description: reason, disabled: blocked || p.empty }] },
    { title: 'Export', actions: [{ label: 'Add to Audiobookshelf', onClick: p.onExport, disabled: blocked, description: reason }] },
    { title: 'Danger', actions: [{ label: 'Force Re-record All…', onClick: p.onForceRecord, description: reason, disabled: blocked || p.empty, danger: true }] },
  ];
}
export function ReviewBookMenu(p: ReviewBookMenuProps) { return <ReviewMenu label="Book Tools" sections={bookToolSections(p)} attention={p.pronunciationAttention} />; }
