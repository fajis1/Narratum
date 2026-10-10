'use client';

import { useState, type ReactNode } from 'react';

/** Keep both panels mounted so navigating never restarts a request or loses review state. */
export function ScanRecoveryWorkspace({ children, recovery, onClose }: {
  children: ReactNode; recovery: ReactNode; onClose?: () => void;
}) {
  const [tab, setTab] = useState<'scan' | 'recovery'>('scan');
  return <div className="relative flex h-[min(85dvh,56rem)] min-h-0 flex-col" data-testid="scan-recovery-workspace">
    <div className="flex shrink-0 items-center justify-between border-b p-2">
      <div role="tablist" aria-label="PDF analysis workspace" className="flex gap-2">
        {(['scan', 'recovery'] as const).map((value) => <button key={value} id={`pdf-${value}-tab`} type="button"
          role="tab" aria-selected={tab === value} aria-controls={`pdf-${value}-panel`} tabIndex={tab === value ? 0 : -1}
          className={`rounded px-3 py-2 text-sm ${tab === value ? 'bg-accent text-white' : 'border'}`}
          onClick={() => setTab(value)} onKeyDown={(event) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next = event.key === 'Home' ? 'scan' : event.key === 'End' ? 'recovery' : value === 'scan' ? 'recovery' : 'scan';
              setTab(next); document.getElementById(`pdf-${next}-tab`)?.focus();
            }
          }}>{value === 'scan' ? 'Pre-Scan' : 'OCR Recovery'}</button>)}
      </div>
      {onClose && <button type="button" className="rounded border px-3 py-2 text-sm" aria-label="Close PDF analysis" onClick={onClose}>Close</button>}
    </div>
    <div id="pdf-scan-panel" role="tabpanel" aria-labelledby="pdf-scan-tab" hidden={tab !== 'scan'}
      className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    <div id="pdf-recovery-panel" role="tabpanel" aria-labelledby="pdf-recovery-tab" hidden={tab !== 'recovery'}
      className="min-h-0 flex-1 overflow-y-auto">{recovery || <p className="p-4">Select a PDF in Pre-Scan to analyze OCR source problems.</p>}</div>
  </div>;
}
