'use client';

import { useEffect, useRef, useState } from 'react';
import type { SourceRecoveryAnalysis, SourceRecoveryOccurrence } from '@/types/source-recovery';

export function SourceRecoveryPanel({ documentId }: { documentId: string }) {
  const [analysis, setAnalysis] = useState<SourceRecoveryAnalysis | null>(null);
  const [groupId, setGroupId] = useState('');
  const [occurrenceId, setOccurrenceId] = useState('');
  const [reading, setReading] = useState('');
  const [pronunciation, setPronunciation] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const session = useRef(0);
  useEffect(() => { session.current++; setAnalysis(null); setGroupId(''); setOccurrenceId(''); setError(''); }, [documentId]);
  async function load() {
    const currentSession = session.current;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/documents/source-recovery?documentId=${encodeURIComponent(documentId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (session.current === currentSession) setAnalysis(data.analysis);
    } catch (error) {
      if (session.current === currentSession) setError(error instanceof Error ? error.message : 'Could not load PDF analysis.');
    } finally { if (session.current === currentSession) setBusy(false); }
  }
  async function action(action: string, item?: SourceRecoveryOccurrence) {
    if (!analysis) return;
    const currentSession = session.current;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/documents/source-recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, revision: analysis.revision, action, groupId,
          occurrenceId: item?.id, correctedSurface: reading, pronunciation, sourceVerified: verified }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (session.current === currentSession) { setAnalysis(data.analysis); setVerified(false); }
    } catch (error) {
      if (session.current === currentSession) setError(error instanceof Error ? error.message : 'Could not save PDF reading.');
    } finally { if (session.current === currentSession) setBusy(false); }
  }
  const groups = new Map<string, SourceRecoveryOccurrence[]>();
  for (const item of analysis?.occurrences || []) groups.set(item.groupId, [...(groups.get(item.groupId) || []), item]);
  const group = groups.get(groupId) || [];
  const item = group.find((entry) => entry.id === occurrenceId);
  useEffect(() => {
    setReading(item?.proposal?.correctedSurface || '');
    setPronunciation(item?.proposal?.pronunciation || ''); setVerified(false);
  }, [item?.id, item?.proposal?.correctedSurface, item?.proposal?.pronunciation]);
  const button = 'rounded border px-3 py-1 text-sm disabled:opacity-50';
  return <details className="max-h-80 shrink-0 overflow-auto border-t p-3 text-sm" onToggle={(event) => {
    if (event.currentTarget.open && !analysis && !busy) void load();
  }}>
    <summary className="cursor-pointer font-semibold">Repair PDF source words</summary>
    <p className="my-2 text-xs text-muted">Corrections apply only to this PDF. Review each printed occurrence before accepting it. Personal and global dictionaries are unchanged. Rerun pre-scan after review to refresh detection and definitions. New audiobook runs use accepted readings; continuing books keep their saved decisions.</p>
    <button type="button" className={button} disabled={busy} onClick={() => void load()}>Refresh PDF analysis</button>
    {error && <p role="alert" className="my-2 text-danger">{error}</p>}
    {busy && <p role="status">Working on PDF evidence…</p>}
    {analysis && !analysis.occurrences.length && <p className="my-2">No indexed source-repair occurrences. Run a new pre-scan to index suspect passages.</p>}
    {!analysis && !busy && !error && <p className="my-2">Run a new pre-scan to create document analysis.</p>}
    {!!groups.size && <div className="mt-3 space-y-3">
      <label className="block">Suspected spelling group
        <select className="block w-full rounded border bg-background p-1" aria-label="Suspected spelling group" value={groupId} disabled={busy} onChange={(event) => { setGroupId(event.target.value); setOccurrenceId(''); }}>
          <option value="">Select a group</option>
          {[...groups].map(([id, entries]) => <option key={id} value={id}>{[...new Set(entries.map((entry) => entry.surface))].join(', ')} — {entries.length} occurrences, {entries.filter((entry) => entry.status === 'approved').length} accepted</option>)}
        </select>
      </label>
      {group.length > 0 && <>
        <button type="button" className={button} disabled={busy || !group.some((entry) => entry.status === 'unresolved')} onClick={() => void action('propose')}>Analyze next 6 occurrences with Gemini</button>
        <p className="text-xs text-muted">Gemini sees page images, this group’s spellings and passage contexts. Dictionary matches identify candidates; they do not approve readings.</p>
        <label className="block">Occurrence
          <select className="block w-full rounded border bg-background p-1" aria-label="Occurrence" value={occurrenceId} disabled={busy} onChange={(event) => setOccurrenceId(event.target.value)}>
            <option value="">Select an occurrence</option>
            {group.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1} of {group.length} — page {entry.pdfPage}: {entry.surface} ({entry.status})</option>)}
          </select>
        </label>
      </>}
      {item && <div className="space-y-2 rounded border p-2">
        <p className="break-words">{item.context}</p>
        <p className="text-xs text-muted">{item.reasons.join(' ')}</p>
        <a className="underline" href={`/api/documents/source-recovery?documentId=${encodeURIComponent(documentId)}&page=${item.pdfPage}`} target="_blank" rel="noreferrer">View original PDF page {item.pdfPage}</a>
        {item.proposal && <>
          <p>{item.proposal.explanation}</p>
          <p className="text-xs">Dictionary: {item.proposal.dictionary ? `${item.proposal.dictionary.source}; lemma ${item.proposal.dictionary.headword}; ${item.proposal.dictionary.morphology || 'morphology unavailable'}` : 'No dictionary match recorded.'}</p>
          <p className="text-xs">Pronunciation: {item.proposal.pronunciationReference ? `Snapshot from ${item.proposal.pronunciationReference.scope} dictionary` : 'Document-local candidate or none'}.</p>
        </>}
        <label className="block">Printed word <input aria-label="Recovered PDF word" className="ml-2 rounded border bg-background p-1" value={reading} disabled={busy} onChange={(event) => { setReading(event.target.value); setPronunciation(''); setVerified(false); }} /></label>
        <label className="block">Kokoro pronunciation (optional) <input className="ml-2 rounded border bg-background p-1" value={pronunciation} disabled={busy} onChange={(event) => setPronunciation(event.target.value)} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={verified} disabled={busy} onChange={(event) => setVerified(event.target.checked)} />I checked this occurrence against the printed PDF word.</label>
        <div className="flex flex-wrap gap-2">
          <button className={button} type="button" disabled={busy || !verified || !reading} onClick={() => void action('approve', item)}>Accept this occurrence</button>
          <button className={button} type="button" disabled={busy} onClick={() => void action('reject', item)}>Reject correction</button>
          <button className={button} type="button" disabled={busy} onClick={() => void action('reset', item)}>Reset for analysis</button>
        </div>
      </div>}
      {analysis?.diagnostics.filter((entry) => entry.groupId === groupId).slice(-3).map((entry, index) => <p key={index} className="text-xs" role="status">{entry.outcome}: {entry.message} {entry.httpStatus ? `(HTTP ${entry.httpStatus})` : ''}</p>)}
    </div>}
  </details>;
}
