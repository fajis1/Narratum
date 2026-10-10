'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SourceRecoveryAnalysis, SourceRecoveryOccurrence, SourceRecoveryConfiguration } from '@/types/source-recovery';
import { GEMINI_MODEL_FALLBACKS } from '@/lib/shared/smart-audio-models';
import { PRESET_MODELS } from '@/components/constants';

function sourceRecoveryPriority(entries: SourceRecoveryOccurrence[]) {
  return entries.length * 100
    + new Set(entries.map((entry) => entry.surface)).size * 20
    + entries.reduce((score, entry) => score + entry.reasons.filter((reason) => /OCR|disagreement|detached|source repair/i.test(reason)).length, 0) * 5;
}

export function SourceRecoveryPanel({ documentId, refreshToken = 0, applicationSummary }: {
  documentId: string; refreshToken?: number; applicationSummary?: { applied: number; unmatched: number };
}) {
  const [analysis, setAnalysis] = useState<SourceRecoveryAnalysis | null>(null);
  const [configuration, setConfiguration] = useState<SourceRecoveryConfiguration | null>(null);
  const [ocrModel, setOcrModel] = useState('');
  const [ocrFallbacks, setOcrFallbacks] = useState<string[] | null>(null);
  const [backupNext, setBackupNext] = useState(false);
  const backupNextRef = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);
  const operationInFlight = useRef(false);
  const pendingRefresh = useRef(false);
  const [now, setNow] = useState(Date.now());
  const [groupId, setGroupId] = useState('');
  const [occurrenceId, setOccurrenceId] = useState('');
  const [reading, setReading] = useState('');
  const [pronunciation, setPronunciation] = useState('');
  const [verified, setVerified] = useState(false);
  const [verifiedProposalIds, setVerifiedProposalIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const stopAfterBatch = useRef(false);
  const [error, setError] = useState('');
  const session = useRef(0);
  useEffect(() => {
    const activeSession = session.current + 1;
    session.current = activeSession; setAnalysis(null); setConfiguration(null); setGroupId(''); setOccurrenceId(''); setError('');
    setOcrModel(''); setOcrFallbacks(null); setBackupNext(false); backupNextRef.current = false;
    return () => { session.current = activeSession + 1; stopAfterBatch.current = true; activeRequest.current?.abort(); };
  }, [documentId]);
  useEffect(() => {
    if (!analysis?.recoveryRun?.nextAttemptAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [analysis?.recoveryRun?.nextAttemptAt]);
  const load = useCallback(async () => {
    if (operationInFlight.current) { pendingRefresh.current = true; return; }
    const currentSession = session.current;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/documents/source-recovery?documentId=${encodeURIComponent(documentId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (session.current === currentSession) { setAnalysis(data.analysis); setConfiguration(data.configuration || null); }
    } catch (error) {
      if (session.current === currentSession) setError(error instanceof Error ? error.message : 'Could not load PDF analysis.');
    } finally { if (session.current === currentSession) setBusy(false); }
  }, [documentId]);
  useEffect(() => { void load(); }, [documentId, refreshToken, load]);
  async function sendAction(action: string, item: SourceRecoveryOccurrence | undefined, base: SourceRecoveryAnalysis,
    extra: Record<string, unknown> = {}): Promise<SourceRecoveryAnalysis> {
    const currentSession = session.current;
    const controller = new AbortController();
    if (action === 'propose') activeRequest.current = controller;
    const useBackupKey = action === 'propose' && backupNextRef.current;
    if (action === 'propose') { backupNextRef.current = false; setBackupNext(false); }
    try {
      const response = await fetch('/api/documents/source-recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ documentId, revision: base.revision, action, groupId,
        occurrenceId: item?.id, correctedSurface: reading, pronunciation, sourceVerified: verified,
        ...(action === 'propose' ? { ...(ocrModel ? { ocrModel } : {}), ...(ocrFallbacks !== null ? { ocrFallbackModels: ocrFallbacks.filter(Boolean) } : {}), useBackupKey } : {}), ...extra }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (session.current === currentSession) {
        setAnalysis(data.analysis); setVerified(false);
        const configuration = data.analysis?.diagnostics?.at(-1)?.configuration;
        if (configuration) setConfiguration(configuration);
      }
      return data.analysis as SourceRecoveryAnalysis;
    } finally { if (activeRequest.current === controller) activeRequest.current = null; }
  }
  async function action(actionName: string, item?: SourceRecoveryOccurrence, extra: Record<string, unknown> = {}) {
    if (!analysis || operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true); setError('');
    try { await sendAction(actionName, item, analysis, extra); }
    catch (error) { setError(error instanceof Error && error.name === 'AbortError' ? 'OCR analysis cancelled. Refresh to see the saved batch state.' : error instanceof Error ? error.message : 'Could not save PDF reading.'); }
    finally { operationInFlight.current = false; setBusy(false); if (pendingRefresh.current) { pendingRefresh.current = false; void load(); } }
  }
  async function analyzeOcrProblems() {
    if (!analysis || busy || operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true); stopAfterBatch.current = false; setError('');
    let current = analysis;
    try {
      // Each persisted request analyzes at most six PDF occurrences. The cap
      // bounds provider use per user action; another click resumes remaining work.
      for (let batch = 0; batch < 12; batch++) {
        if (stopAfterBatch.current) break;
        const ranked = new Map<string, SourceRecoveryOccurrence[]>();
        for (const entry of current.occurrences) if (entry.status === 'unresolved' && !entry.anchorInvalidated) {
          ranked.set(entry.groupId, [...(ranked.get(entry.groupId) || []), entry]);
        }
        const nextGroup = [...ranked].sort((a, b) => sourceRecoveryPriority(b[1]) - sourceRecoveryPriority(a[1]) || a[0].localeCompare(b[0]))[0];
        if (!nextGroup) break;
        current = await sendAction('propose', undefined, current, { groupId: nextGroup[0] });
        const diagnostic = current.diagnostics.at(-1);
        // History is capped at 100; its length cannot tell us whether this batch failed.
        if (diagnostic && diagnostic.outcome !== 'proposed') break;
      }
    } catch (error) { setError(error instanceof Error && error.name === 'AbortError' ? 'OCR analysis cancelled. Saved proposals and approvals remain; refresh before continuing.' : error instanceof Error ? error.message : 'OCR analysis stopped. Saved proposals remain available.'); }
    finally { operationInFlight.current = false; setBusy(false); stopAfterBatch.current = false; if (pendingRefresh.current) { pendingRefresh.current = false; void load(); } }
  }
  const groups = new Map<string, SourceRecoveryOccurrence[]>();
  for (const item of analysis?.occurrences || []) groups.set(item.groupId, [...(groups.get(item.groupId) || []), item]);
  const group = groups.get(groupId) || [];
  const item = group.find((entry) => entry.id === occurrenceId);
  const summary = {
    total: analysis?.occurrences.filter((entry) => !entry.anchorInvalidated).length || 0,
    invalidated: analysis?.occurrences.filter((entry) => entry.anchorInvalidated).length || 0,
    analyzed: analysis?.occurrences.filter((entry) => entry.analyzedAt).length || 0,
    proposals: analysis?.occurrences.filter((entry) => entry.status === 'proposed').length || 0,
    ambiguous: analysis?.occurrences.filter((entry) => entry.status === 'ambiguous').length || 0,
    approved: analysis?.occurrences.filter((entry) => entry.status === 'approved').length || 0,
    unresolved: analysis?.occurrences.filter((entry) => entry.status === 'unresolved' && !entry.anchorInvalidated).length || 0,
  };
  const priorityGroups = [...groups].sort((a, b) => sourceRecoveryPriority(b[1]) - sourceRecoveryPriority(a[1]) || a[0].localeCompare(b[0]));
  useEffect(() => {
    if (!groupId && analysis?.occurrences.length) {
      const candidates = new Map<string, SourceRecoveryOccurrence[]>();
      for (const entry of analysis.occurrences) candidates.set(entry.groupId, [...(candidates.get(entry.groupId) || []), entry]);
      const reviewable = [...candidates].filter(([, entries]) => entries.some((entry) => !entry.anchorInvalidated && (entry.status === 'proposed' || entry.status === 'unresolved')))
        .sort((a, b) => sourceRecoveryPriority(b[1]) - sourceRecoveryPriority(a[1]) || a[0].localeCompare(b[0]))[0];
      if (reviewable) setGroupId(reviewable[0]);
    }
  }, [groupId, analysis]);
  useEffect(() => {
    setReading(item?.proposal?.correctedSurface || '');
    setPronunciation(item?.proposal?.pronunciation || ''); setVerified(false);
  }, [item?.id, item?.proposal?.correctedSurface, item?.proposal?.pronunciation]);
  const button = 'rounded border px-3 py-1 text-sm disabled:opacity-50';
  const coolingDown = (analysis?.recoveryRun?.nextAttemptAt || 0) > now && !backupNext;
  const effectiveModel = ocrModel || configuration?.model || '';
  const effectiveFallbacks = ocrFallbacks?.filter(Boolean).length ? ocrFallbacks.filter(Boolean)
    : ocrModel ? [...(GEMINI_MODEL_FALLBACKS[ocrModel] || [])] : configuration?.fallbackModels || [];
  return <section aria-label="OCR source recovery" className="min-w-0 p-3 text-sm">
    <h4 className="font-semibold">OCR source recovery</h4>
    <p className="my-1 text-xs text-muted">Pre-scan detects suspicious spellings but does not analyze them. Analyze proposals against PDF page images, then verify each selected reading before accepting it. Corrections stay local to this PDF; the original extraction and shared dictionaries are unchanged.</p>
    {error && <p role="alert" className="my-2 text-danger">{error}</p>}
    {configuration && <fieldset className="my-3 min-w-0 space-y-2 rounded border p-3" disabled={busy}>
      <legend className="font-semibold">OCR Gemini configuration</legend>
      <p>Smart Audio profile: {configuration.profileName}</p>
      <p className="break-words">Primary key: {configuration.primaryKeyConfigured ? 'configured' : 'not configured'} · Backup key: {configuration.backupKeyConfigured ? 'configured' : 'not configured'} · Automatic backup-key failover: {configuration.automaticBackupFailover ? 'enabled' : 'disabled'}</p>
      <p className="text-xs">These controls apply to OCR analysis only. Pre-Scan pronunciation controls are separate. Credentials are resolved from this saved profile on the server.</p>
      <label className="block">OCR Gemini model <select aria-label="OCR Gemini model" className="block w-full rounded border bg-background p-1" value={effectiveModel}
        onChange={(event) => { setOcrModel(event.target.value); setOcrFallbacks(null); }}>
        {[...new Set([effectiveModel, ...PRESET_MODELS.map((model) => model.id).filter((id) => id.startsWith('gemini-'))])].map((model) => <option key={model} value={model}>{model}</option>)}
      </select></label>
      {[0, 1].map((index) => <label key={index} className="block">OCR fallback model {index + 1}<select aria-label={`OCR fallback model ${index + 1}`}
        className="block w-full rounded border bg-background p-1" value={effectiveFallbacks[index] || ''}
        onChange={(event) => { const next = [...effectiveFallbacks]; next[index] = event.target.value; setOcrFallbacks(next); }}>
        <option value="">Default fallback sequence</option>
        {[...new Set([...effectiveFallbacks, ...PRESET_MODELS.map((model) => model.id).filter((id) => id.startsWith('gemini-'))])].filter((model) => model !== effectiveModel).map((model) => <option key={model} value={model}>{model}</option>)}
      </select></label>)}
      <p className="break-words text-xs">Effective sequence: {[effectiveModel, ...effectiveFallbacks].join(' → ')}</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={backupNext} disabled={busy || !configuration.backupKeyConfigured}
        onChange={(event) => { setBackupNext(event.target.checked); backupNextRef.current = event.target.checked; }} />Use backup API key for next OCR analysis</label>
    </fieldset>}
    {busy && <p role="status">Analyzing saved batches {summary.analyzed} of {summary.total}. Proposals are saved after each batch.</p>}
    {analysis && <p className="my-1 text-xs">Occurrences {summary.total} · analyzed {summary.analyzed} · proposals awaiting review {summary.proposals} · ambiguous {summary.ambiguous} · approved {summary.approved} · not analyzed {summary.unresolved}</p>}
    {!!summary.invalidated && <p role="status">{summary.invalidated} source anchor(s) invalidated by rescanning; review the newly indexed occurrences. Prior evidence is retained.</p>}
    {analysis && refreshToken > 0 && applicationSummary && <p className="my-1 text-xs" role="status">Last pre-scan: {applicationSummary.applied} approved reading(s) applied to effective results; {applicationSummary.unmatched} anchor mismatch(es); {Math.max(0, summary.approved - applicationSummary.applied - applicationSummary.unmatched)} approved reading(s) not represented in the last effective scan; {Math.max(0, summary.total - applicationSummary.applied)} occurrence(s) remain unresolved. Raw PDF extraction is preserved.</p>}
    {analysis?.recoveryRun?.status === 'provider_unavailable' && <p className="my-1 text-xs text-warning" role="status">{analysis.diagnostics.at(-1)?.attempted === false ? 'The previous analysis failed before contacting Gemini. Refresh and retry to obtain stage-specific diagnostics.' : 'Gemini provider requests did not complete. See the recorded attempts below. Saved proposals remain.'}</p>}
    {coolingDown && <p role="status">Provider cooldown until {new Date(analysis!.recoveryRun!.nextAttemptAt!).toLocaleTimeString()}. No new request will start before then.</p>}
    {analysis?.diagnostics.slice(-5).map((entry, index) => <div key={`${entry.at}-${index}`} className="my-2 rounded border p-2 text-xs" role="status">
      <p>{new Date(entry.at).toLocaleString()}{entry.occurrenceIds ? ` · ${entry.occurrenceIds.length} occurrences` : ''}</p>
      <p>{entry.stage || entry.outcome}: {entry.message} {entry.httpStatus ? `(HTTP ${entry.httpStatus})` : ''}</p>
      <p>{entry.attempts ? entry.attempts.length : entry.attempted ? 'Unknown number of' : 0} Gemini request(s){entry.configuration ? ` · Profile: ${entry.configuration.profileName}` : ''}</p>
      {entry.attempts?.map((attempt) => <p key={attempt.attempt} className="break-words">
        {attempt.attempt}. {attempt.keyRole === 'backup' ? 'Backup' : 'Primary'} / {attempt.model || 'configured model'} — {attempt.httpStatus ? `HTTP ${attempt.httpStatus}` : attempt.errorCategory || attempt.outcome}
        {attempt.httpStatus && attempt.errorCategory ? ` — ${attempt.errorCategory}` : ''}
        {attempt.outcome === 'success' ? ' — response received' : attempt.retryable ? ' — recoverable' : ' — stopped'}{attempt.fallbackAttempted ? ' · fallback attempted' : ''}
      </p>)}
    </div>)}
    {analysis?.recoveryRun?.status === 'paused' && <p className="my-1 text-xs text-muted" role="status">Analysis is resumable. Each action analyzes at most 72 occurrences in six-item requests.</p>}
    {analysis?.recoveryRun?.status === 'completed' && <p className="my-1 text-xs text-muted" role="status">All indexed occurrences have a proposal or an explicit ambiguous result. Review is still required.</p>}
    {analysis && !analysis.occurrences.length && <p className="my-2">No indexed source-repair occurrences. Run a pre-scan to index suspect passages.</p>}
    {!analysis && !busy && !error && <p className="my-2" role="status">OCR analysis has not been run. Run a pre-scan to index suspicious passages.</p>}
    {analysis && summary.unresolved > 0 && <div className="my-2 flex flex-wrap gap-2">
      <button type="button" className={`${button} font-semibold`} disabled={busy || coolingDown} onClick={() => void analyzeOcrProblems()}>{summary.analyzed ? 'Continue OCR analysis' : 'Analyze OCR Problems'}</button>
      {busy && <button type="button" className={button} onClick={() => { stopAfterBatch.current = true; }}>Stop after this batch</button>}
      {busy && <button type="button" className={button} onClick={() => { stopAfterBatch.current = true; activeRequest.current?.abort(); }}>Cancel OCR analysis</button>}
      <button type="button" className={button} disabled={busy} onClick={() => void load()}>Refresh</button>
    </div>}
    {!!groups.size && <div className="mt-3 space-y-3">
      <label className="block">Suspected spelling group
        <select className="block w-full rounded border bg-background p-1" aria-label="Suspected spelling group" value={groupId} disabled={busy} onChange={(event) => { setGroupId(event.target.value); setOccurrenceId(''); }}>
          <option value="">Select a group</option>
          {priorityGroups.map(([id, entries]) => <option key={id} value={id}>{[...new Set(entries.map((entry) => entry.surface))].join(', ')} — {entries.length} occurrences, {entries.filter((entry) => entry.status === 'approved').length} accepted</option>)}
        </select>
      </label>
      {group.length > 0 && <>
        <button type="button" className={button} disabled={busy || coolingDown || !group.some((entry) => entry.status === 'unresolved')} onClick={() => void action('propose')}>Analyze next 6 occurrences with Gemini</button>
        <p className="text-xs text-muted">Gemini sees page images, this group’s spellings and passage contexts. Dictionary matches identify candidates; they do not approve readings.</p>
        {!!group.some((entry) => entry.status === 'proposed') && <div className="space-y-1 rounded border p-2">
          <p className="font-medium">Review proposals in a batch. Open each linked page and check its printed surface before selecting it.</p>
          {group.filter((entry) => entry.status === 'proposed').map((entry) => <label key={entry.id} className="flex items-start gap-2">
            <input type="checkbox" aria-label={`I verified occurrence on page ${entry.pdfPage}`} checked={verifiedProposalIds.includes(entry.id)} disabled={busy}
              onChange={(event) => setVerifiedProposalIds((ids) => event.target.checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id))} />
            <span>{entry.surface} → {entry.proposal?.correctedSurface} · page {entry.pdfPage} · <a className="underline" href={`/api/documents/source-recovery?documentId=${encodeURIComponent(documentId)}&page=${entry.pdfPage}`} target="_blank" rel="noreferrer">view PDF page</a></span>
          </label>)}
          <button type="button" className={button} disabled={busy || !verifiedProposalIds.some((id) => group.some((entry) => entry.id === id && entry.status === 'proposed'))}
            onClick={() => void action('approve_many', undefined, { occurrenceIds: verifiedProposalIds.filter((id) => group.some((entry) => entry.id === id && entry.status === 'proposed')), sourceVerifiedOccurrenceIds: verifiedProposalIds })}>
            Approve {verifiedProposalIds.filter((id) => group.some((entry) => entry.id === id && entry.status === 'proposed')).length} selected
          </button>
        </div>}
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
    </div>}
  </section>;
}
