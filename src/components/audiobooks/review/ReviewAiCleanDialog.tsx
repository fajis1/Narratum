"use client";
import { ModalFrame, ModalTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
export function ReviewAiCleanDialog({ open, onClose, target, onTarget, profileId, profiles, onProfile, onSettings, onClean, busy }: {
  open: boolean; onClose: () => void; target: 'edited' | 'original'; onTarget: (target: 'edited' | 'original') => void;
  profileId: string; profiles: Array<{ id: string; name: string }>; onProfile: (id: string) => void; onSettings: () => void; onClean: () => void; busy: boolean;
}) {
  return <ModalFrame open={open} onClose={onClose} size="sm">
    <ModalTitle>AI Clean Chapter</ModalTitle>
    <fieldset className="my-4 space-y-3 text-sm text-foreground"><legend className="mb-2 font-medium">Use text from:</legend>
      {(['edited', 'original'] as const).map(value => <label key={value} className="flex min-h-11 cursor-pointer gap-2">
        <input type="radio" name="clean-source" value={value} checked={target === value} onChange={() => onTarget(value)} disabled={busy} className="mt-1 accent-accent" />
        <span>{value === 'edited' ? 'Edited text' : 'Original text'}<span className="block text-xs text-soft">{value === 'edited' ? 'Use the text currently shown in the editor.' : 'Start over from the extracted original chapter text.'}</span></span>
      </label>)}
    </fieldset>
    <label className="block text-sm font-medium text-foreground">Profile
      <select value={profileId} onChange={e => onProfile(e.target.value)} disabled={busy} className="mt-1 min-h-11 w-full rounded border border-line bg-surface p-2 text-foreground focus-visible:ring-2 focus-visible:ring-accent">
        {profiles.length ? profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>) : <option value="">Default profile</option>}
      </select>
    </label>
    <div className="mt-4 flex justify-end gap-2"><Button className="min-h-11" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" className="min-h-11" onClick={onClean} disabled={busy}>{busy ? 'Cleaning…' : 'Clean Chapter'}</Button></div>
    <div className="mt-4 border-t border-line-soft pt-2"><Button variant="ghost" onClick={onSettings}>AI Settings…</Button></div>
  </ModalFrame>;
}
