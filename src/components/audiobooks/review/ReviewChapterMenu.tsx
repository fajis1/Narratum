"use client";
import { ReviewMenu, type ReviewMenuSection } from './ReviewMenus';

export interface ReviewChapterMenuProps {
  onDictionary: () => void; onAbbreviation: () => void; onFixAbbreviations: () => void;
  onSettings: () => void; onErrorLog: () => void; onRecord: () => void;
  onDrama?: () => void;
  hasError: boolean; dirty: boolean; busy: boolean;
}
export function chapterToolSections(p: ReviewChapterMenuProps): ReviewMenuSection[] {
  return [
    { title: 'Chapter Text', actions: [
      { label: 'Pronunciation / Dictionary…', onClick: p.onDictionary, disabled: p.busy },
      { label: 'Add abbreviation…', onClick: p.onAbbreviation },
      { label: 'Fix abbreviations in this chapter', onClick: p.onFixAbbreviations, disabled: p.busy },
    ] },
    ...(p.onDrama ? [{ title: 'Audio Drama', actions: [{ label: 'Audio Drama Studio', onClick: p.onDrama, className: 'hidden md:flex lg:hidden' }] }] : []),
    { title: 'AI', actions: [{ label: 'AI profile settings…', onClick: p.onSettings }] },
    { title: 'Diagnostics', actions: [{ label: 'View error log', onClick: p.onErrorLog, hidden: !p.hasError }] },
    { title: 'Recording', actions: [{ label: 'Re-record chapter', onClick: p.onRecord, hidden: p.dirty, disabled: p.busy }] },
  ];
}
export function ReviewChapterMenu(p: ReviewChapterMenuProps) { return <ReviewMenu label="Chapter Tools" sections={chapterToolSections(p)} />; }
