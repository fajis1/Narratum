"use client";
import { ReviewMenu, type ReviewMenuSection } from './ReviewMenus';

export interface ReviewBookMenuProps {
  onScan: () => void; onReviewChanges: () => void; onFixAll: () => void;
  onBatchRefine: () => void; onRecordModified: () => void; onExport: () => void; onForceRecord: () => void;
  fixing: boolean; rebuilding: boolean; empty: boolean; showReviewChanges: boolean;
}
export function bookToolSections(p: ReviewBookMenuProps): ReviewMenuSection[] {
  return [
    { title: 'Review', actions: [
      { label: 'Scan Pronunciation Issues', onClick: p.onScan },
      { label: 'Review AI Changes', onClick: p.onReviewChanges, hidden: !p.showReviewChanges },
    ] },
    { title: 'Book Text', actions: [
      { label: p.fixing ? 'Fixing abbreviations…' : 'Fix All Abbreviations', onClick: p.onFixAll, disabled: p.fixing || p.rebuilding || p.empty },
      { label: 'AI Batch Refine…', onClick: p.onBatchRefine },
    ] },
    { title: 'Recording', actions: [{ label: p.rebuilding ? 'Scanning chapters…' : 'Re-record Modified Chapters', onClick: p.onRecordModified, disabled: p.rebuilding || p.empty }] },
    { title: 'Export', actions: [{ label: 'Add to Audiobookshelf', onClick: p.onExport }] },
    { title: 'Danger', actions: [{ label: 'Force Re-record All…', onClick: p.onForceRecord, disabled: p.rebuilding || p.empty, danger: true }] },
  ];
}
export function ReviewBookMenu(p: ReviewBookMenuProps) { return <ReviewMenu label="Book Tools" sections={bookToolSections(p)} />; }
