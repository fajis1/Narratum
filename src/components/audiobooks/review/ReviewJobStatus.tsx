"use client";
import { Button } from '@/components/ui/button';
import { MenuItem } from '@headlessui/react';
import { MenuRoot, MenuTrigger, MenuTransition, MenuItemsSurface, MenuActionItem } from '@/components/ui/menu';
import { IconButton } from '@/components/ui/icon-button';
export function ReviewJobStatus({ label, progress, waiting, reviewChanges, onReview, changelogUrl, onCancel }: {
  label: string; progress: number; waiting: boolean; reviewChanges: boolean; onReview: () => void; changelogUrl: string; onCancel: () => void;
}) {
  const percent = Math.max(0, Math.min(100, Math.round(progress)));
  return <section className="flex min-h-10 flex-none items-center gap-3 border-b border-line-soft bg-surface-sunken px-3 py-1 text-xs text-foreground" aria-label="Background job">
    <span title={waiting ? 'Kokoro will start automatically when the shared GPU is ready.' : undefined} role="status" className="min-w-0 flex-1 truncate">{label}{waiting ? ' · Waiting for GPU' : ` · ${percent}%`}</span>
    {!waiting && <progress aria-label={`${label} progress`} value={percent} max={100} className="hidden h-1.5 w-32 accent-accent sm:block" />}
    {reviewChanges && <Button variant="outline" size="sm" onClick={onReview}>Review Changes</Button>}
    <MenuRoot>
      <MenuTrigger as={IconButton} aria-label="Background job tools" title="Background job tools" className="min-h-11 min-w-11 md:min-h-8 md:min-w-8">⋯</MenuTrigger>
      <MenuTransition><MenuItemsSurface anchor="bottom end" portal className="z-[60] w-52">
        {reviewChanges && <MenuItem><a href={changelogUrl} target="_blank" rel="noopener noreferrer" className="block rounded px-2 py-2 text-xs text-foreground data-focus:bg-accent-wash">Raw Changelog</a></MenuItem>}
        <MenuActionItem tone="danger" onClick={onCancel}>Stop &amp; Cancel</MenuActionItem>
      </MenuItemsSurface></MenuTransition>
    </MenuRoot>
  </section>;
}
