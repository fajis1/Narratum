"use client";
import { ModalFrame, ModalTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
export function ReviewUnsavedChangesDialog({ open, title, busy, onSave, onDiscard, onStay }: {
  open: boolean; title: string; busy: boolean; onSave: () => void; onDiscard: () => void; onStay: () => void;
}) {
  return <ModalFrame open={open} onClose={() => { if (!busy) onStay(); }} size="sm" className="z-[80]">
    <ModalTitle>Unsaved changes</ModalTitle>
    <p className="my-4 text-sm text-foreground">You have unsaved changes to {title}. Save them before leaving?</p>
    <div className="flex flex-wrap justify-end gap-2">
      <Button className="min-h-11" onClick={onStay} disabled={busy} data-autofocus>Stay Here</Button>
      <Button variant="outline" className="min-h-11 text-danger" onClick={onDiscard} disabled={busy}>Discard Changes</Button>
      <Button variant="primary" className="min-h-11" onClick={onSave} disabled={busy}>{busy ? 'Re-recording…' : 'Save & Re-record'}</Button>
    </div>
  </ModalFrame>;
}
