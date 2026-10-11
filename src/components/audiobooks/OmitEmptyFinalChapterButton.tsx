'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export function OmitEmptyFinalChapterButton({ bookId, chapterIndex, snapshotHash, disabled, onOmitted }: {
  bookId: string; chapterIndex: number; snapshotHash: string; disabled?: boolean; onOmitted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const omit = async () => {
    if (pending.current || disabled) return;
    pending.current = true;
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/audiobook/omit-empty-final-chapter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, chapterIndex, snapshotHash, confirmOmit: true }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body?.error === 'string' ? body.error : 'Could not omit the empty final chapter.');
      }
      onOmitted();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not omit the empty final chapter.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <div>
    <Button size="sm" disabled={disabled || busy} onClick={() => { setError(null); setConfirming(true); }}>
      {busy ? 'Omitting chapter…' : 'Omit empty final chapter'}
    </Button>
    {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    <ConfirmDialog isOpen={confirming} onClose={() => setConfirming(false)} onConfirm={() => { void omit(); }}
      title={`Omit chapter ${chapterIndex + 1}?`}
      message={`Chapter ${chapterIndex + 1} has no saved text or recording. Confirm that this final chapter contains no content you want in the audiobook. It will be excluded from the full book and Audiobookshelf upload. Existing recordings will be preserved.`}
      confirmText="Confirm omission" />
  </div>;
}
