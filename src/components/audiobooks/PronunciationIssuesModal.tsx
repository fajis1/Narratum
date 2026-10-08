"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { ModalFrame } from '@/components/ui';
import { BatchRefineReviewModal } from './BatchRefineReviewModal';
import type { PronunciationIssue } from '@/lib/shared/pronunciation-issues';
import { PRESET_MODELS } from '@/components/constants';
import { readJsonResponse } from '@/lib/client/read-json-response';
import { v4 as uuidv4 } from 'uuid';
import { pronunciationRepairStatusLabel, type PronunciationRepairStatus } from '@/lib/shared/pronunciation-repair-status';
import type { PronunciationOverrideScanDiagnostic } from '@/lib/shared/pronunciation-review-acknowledgment';

type Chapter = { fileName: string; chapterIndex: number; failed: boolean };
type Finding = Chapter & { title: string; hash: string; issues: PronunciationIssue[]; jobId?: string; failureError?: string; runId?: string; audioStatus?: string; error?: string; retryRunId?: string; proposalHash?: string; unresolvedCount?: number; overrideDiagnostic?: PronunciationOverrideScanDiagnostic };
type RepairConfig = { selectedProfileId: string; recordingVoice: string; recordingVoices: string[]; modelFallbacks?: Record<string, string[]>; profiles: { id: string; name: string; model: string; primaryKeyRef: string; backupKeyRef: string }[]; keySources: { ref: string; label: string; masked: string }[] };
type RepairJob = { id: string; status: string; progress: number; total: number; error?: string; profileId?: string; aiModel?: string; primaryKeyRef?: string; backupKeyRef?: string; nextAttemptAt?: number; results: { fileName: string; runId?: string; unresolvedCount?: number; error?: string; requestId: string; apiBlocked?: boolean }[] };

export function PronunciationIssuesModal({ open, onClose, bookId, profileId, onRecordingQueued, onScanResult, onReviewStatus }: {
  open: boolean; onClose: () => void; bookId: string; profileId?: string; onRecordingQueued: () => void;
  onScanResult?: (chapterIndex: number, issueCount: number) => void;
  onReviewStatus?: (repairs: PronunciationRepairStatus[]) => void;
}) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [reviewRun, setReviewRun] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);
  const [config, setConfig] = useState<RepairConfig | null>(null);
  const [recordingVoice, setRecordingVoice] = useState('');
  const [selection, setSelection] = useState({ profileId: profileId || '', aiModel: '', primaryKeyRef: '', backupKeyRef: '' });
  const [customModel, setCustomModel] = useState(false);
  const [fallbackModels, setFallbackModels] = useState<string[] | undefined>();
  const effectiveFallbacks = fallbackModels ?? config?.modelFallbacks?.[selection.aiModel] ?? [];
  const [job, setJob] = useState<RepairJob | null>(null);
  const [reportJobs, setReportJobs] = useState<RepairJob[]>([]);
  const [reportJobId, setReportJobId] = useState('');
  const [reportDownloading, setReportDownloading] = useState(false);
  const reportController = useRef<AbortController | null>(null);
  const jobVersion = useRef('');
  const activeRepair = job?.status === 'queued' || job?.status === 'running';
  const [repairs, setRepairs] = useState<PronunciationRepairStatus[]>([]);
  const [approvalMessage, setApprovalMessage] = useState('');
  const [approving, setApproving] = useState(false);
  const [override, setOverride] = useState(false);
  const [scanDiagnostics, setScanDiagnostics] = useState<Array<{ chapterIndex: number; fileName: string; diagnostic?: PronunciationOverrideScanDiagnostic }>>([]);
  useEffect(() => { setOverride(false); }, [open, bookId]);
  const refreshRepairs = useCallback(async (signal?: AbortSignal) => {
    const value = await fetch(`/api/audiobooks/pronunciation-issues?bookId=${encodeURIComponent(bookId)}&action=review-status`, { signal, cache: 'no-store' }).then(readJsonResponse);
    if (!signal?.aborted) { setRepairs(value.repairs || []); onReviewStatus?.(value.repairs || []); }
  }, [bookId, onReviewStatus]);
  useEffect(() => {
    if (!open) return;
    const current = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refreshRepairs(current.signal); }
      catch (problem) { if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Could not refresh repair status.'); }
      finally { if (!current.signal.aborted) timer = setTimeout(() => void poll(), 4000); }
    };
    void poll();
    return () => { current.abort(); clearTimeout(timer); };
  }, [open, refreshRepairs]);
  const readyRepairs = repairs.filter(repair => override ? repair.decision === 'pending' : repair.ready);
  const failedRecordings = repairs.filter(repair => repair.decision === 'approved' && repair.audioStatus === 'error');
  const displayedFindings = [...findings];
  for (const repair of repairs) {
    if (!displayedFindings.some(row => row.chapterIndex === repair.chapterIndex)) {
      displayedFindings.push({ ...repair, hash: '', issues: [], failed: repair.fileName.endsWith('__rejected.txt') });
    }
  }
  displayedFindings.sort((a, b) => a.chapterIndex - b.chapterIndex);

  async function approveReady() {
    if (approving || activeRepair || !readyRepairs.length) return;
    const targets = [...readyRepairs];
    if (!window.confirm(override ? `Override pronunciation warnings and approve all ${targets.length} pending proposals for recording? Source text and speaker assignments remain protected.` : `Approve ${targets.length} ready repairs and queue their replacement recordings? Partial proposals will be left for review.`)) return;
    setApproving(true); setBusy(true); setApprovalMessage('');
    let approved = 0;
    const failures: string[] = [];
    try {
      for (const repair of targets) {
        try {
          await fetch('/api/audiobooks/batch-refine/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'approve', changeId: repair.changeId, recordingVoice, ...(override ? { overridePronunciationReview: true } : {}) }),
          }).then(readJsonResponse);
          approved += 1;
        } catch (problem) { failures.push(`${repair.title}: ${problem instanceof Error ? problem.message : 'Approval failed'}`); }
      }
      setApprovalMessage(`${approved} repairs approved. ${failures.length ? failures.join(' · ') : override ? 'Reviewer Override recorded for accepted proposals.' : 'Partial proposals were left untouched.'}`);
      if (approved) onRecordingQueued();
      await refreshRepairs();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not refresh repair status.'); }
    finally { setApproving(false); setBusy(false); }
  }

  async function retryFailedRecordings() {
    if (busy || activeRepair || !failedRecordings.length) return;
    const targets = [...failedRecordings];
    if (!window.confirm(`Retry ${targets.length} failed recordings using their already-approved text? No repairs will be approved again. Keep this window open until queuing finishes.`)) return;
    setBusy(true); setApprovalMessage('');
    let queued = 0;
    let failure = '';
    try {
      for (const repair of targets) {
        setApprovalMessage(`Queuing failed recordings: ${queued}/${targets.length}…`);
        try {
          await fetch('/api/audiobooks/batch-refine/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'retry', changeId: repair.changeId, recordingVoice }),
          }).then(readJsonResponse);
          queued += 1;
        } catch (problem) {
          failure = `${repair.title}: ${problem instanceof Error ? problem.message : 'Retry failed'}`;
          break;
        }
      }
      setApprovalMessage(`${queued} recordings queued. ${failure ? `Stopped: ${failure}. Remaining recordings were left unchanged.` : 'Already-approved text was preserved.'}`);
      if (queued) onRecordingQueued();
      await refreshRepairs();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not refresh recording status.'); }
    finally { setBusy(false); }
  }

  async function rememberApproved() {
    if (!window.confirm('Remember reusable pronunciations from approved repairs for this book and its lexicon profile? Existing conflicting entries and contextual forms will be left unchanged.')) return;
    setBusy(true); setApprovalMessage('');
    try {
      const result = await fetch('/api/audiobooks/pronunciation-issues', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, action: 'remember-approved' }),
      }).then(readJsonResponse);
      setApprovalMessage(result.message || `Remembered ${result.saved} pronunciations for this book; ${result.alreadyKnown} already remembered; ${result.skipped} unsafe or conflicting candidates skipped.`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not remember pronunciations.'); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!open) return;
    const current = new AbortController();
    void fetch(`/api/audiobooks/pronunciation-issues?bookId=${encodeURIComponent(bookId)}&action=config`, { signal: current.signal, cache: 'no-store' })
      .then(readJsonResponse).then((value: RepairConfig) => {
        if (current.signal.aborted) return;
        setConfig(value);
        const rememberedVoice = window.localStorage.getItem(`pronunciation-repair-voice:${bookId}`);
        setRecordingVoice(rememberedVoice && value.recordingVoices.includes(rememberedVoice) ? rememberedVoice : value.recordingVoice);
        setFallbackModels(undefined);
        const profile = value.profiles.find(item => item.id === profileId) || value.profiles.find(item => item.id === value.selectedProfileId) || value.profiles[0];
        if (profile) {
          setSelection({ profileId: profile.id, aiModel: profile.model, primaryKeyRef: profile.primaryKeyRef, backupKeyRef: profile.backupKeyRef });
          setCustomModel(!PRESET_MODELS.some(model => model.id !== 'custom' && model.id === profile.model));
        }
      }).catch(problem => { if (!current.signal.aborted) setError(problem.message); });
    return () => current.abort();
  }, [open, bookId, profileId]);

  useEffect(() => {
    if (!open) return;
    const current = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await fetch(`/api/audiobooks/pronunciation-issues?bookId=${encodeURIComponent(bookId)}&action=jobs`, { signal: current.signal, cache: 'no-store' }).then(readJsonResponse);
        if (current.signal.aborted) return;
        const latest: RepairJob | undefined = value.jobs[0];
        setReportJobs(value.jobs);
        setJob(latest || null);
        const version = JSON.stringify(latest);
        if (latest && version !== jobVersion.current) {
          jobVersion.current = version;
          setFindings(previous => {
            const next = [...previous];
            for (const result of latest.results) {
              const index = next.findIndex(row => row.fileName === result.fileName);
              const chapterIndex = Number(result.fileName.split('__')[0]) - 1;
              const row = index >= 0 ? next[index] : { fileName: result.fileName, chapterIndex, title: `Chapter ${chapterIndex + 1}`, hash: '', issues: [], failed: result.fileName.endsWith('__rejected.txt') };
              const updated = { ...row, runId: result.runId, unresolvedCount: result.unresolvedCount, error: result.error ? `${result.error} Reference: ${result.requestId}` : undefined };
              if (index >= 0) next[index] = updated; else next.push(updated);
            }
            return next;
          });
          setSelected(previous => previous.filter(file => !latest.results.some(result => result.fileName === file && result.runId)));
          const ready = latest.results.filter(result => result.runId && !result.error).length;
          const partial = latest.results.filter(result => result.runId && !result.error && (result.unresolvedCount || result.apiBlocked)).length;
          const retained = latest.results.filter(result => result.runId && result.error).length;
          const failed = latest.results.filter(result => result.error).length;
          const blocked = latest.results.filter(result => result.apiBlocked).length;
          setStatus(`Repair job ${latest.status}: ${latest.results.length}/${latest.total} checked; ${ready - partial} complete proposals; ${partial} partial proposals; ${retained} older proposals retained after failed retries; ${blocked} API-blocked chapters (including partial proposals); ${failed} failed attempts. ${latest.nextAttemptAt && latest.status === 'queued' ? `Waiting until ${new Date(latest.nextAttemptAt).toLocaleString()} before retrying.` : latest.status === 'running' ? 'You can close this window; work continues in the background.' : 'Review saved proposals or scan again to retry unresolved findings.'}`);
        }
      } catch (problem) { if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Could not load repair progress.'); }
      finally { if (!current.signal.aborted) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll();
    return () => { current.abort(); clearTimeout(timer); };
  }, [open, bookId]);

  useEffect(() => {
    if (!open) controller.current?.abort();
    if (!open) reportController.current?.abort();
    return () => { controller.current?.abort(); reportController.current?.abort(); };
  }, [open]);
  useEffect(() => {
    controller.current?.abort();
    setFindings([]); setSelected([]); setDrafts({}); setScanned(false); setStatus(''); setError(''); setReviewRun(null);
    setJob(null); jobVersion.current = '';
    setRecordingVoice('');
    setRepairs([]); setApprovalMessage('');
    setScanDiagnostics([]);
    setReportJobs([]); setReportJobId('');
    reportController.current?.abort();
  }, [bookId, profileId]);

  async function request(body: Record<string, unknown>, signal: AbortSignal) {
    const response = await fetch('/api/audiobooks/pronunciation-issues', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId, ...selection, fallbackModels: effectiveFallbacks, ...body }) });
    return readJsonResponse(response);
  }

  async function downloadReport() {
    const id = reportJobId || reportJobs[0]?.id;
    if (!id) return;
    const current = new AbortController();
    reportController.current?.abort(); reportController.current = current;
    setReportDownloading(true); setError('');
    try {
      const report = await fetch(`/api/audiobooks/pronunciation-issues?bookId=${encodeURIComponent(bookId)}&action=report&jobId=${encodeURIComponent(id)}`, { signal: current.signal, cache: 'no-store' }).then(readJsonResponse);
      current.signal.throwIfAborted();
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = `pronunciation-repair-${id}.json`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) { if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Could not download repair report.'); }
    finally { if (reportController.current === current) setReportDownloading(false); }
  }

  function downloadScanLog() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ bookId, timestamp: new Date().toISOString(),
      scans: scanDiagnostics }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'pronunciation-override-scan-log.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function scan() {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setFindings([]); setSelected([]); setDrafts({}); setScanned(false); setScanDiagnostics([]);
    try {
      const response = await fetch(`/api/audiobooks/pronunciation-issues?bookId=${encodeURIComponent(bookId)}`, { signal: current.signal, cache: 'no-store' });
      const catalog = await readJsonResponse(response);
      const chapters: Chapter[] = catalog.chapters;
      for (const [index, chapter] of chapters.entries()) {
        current.signal.throwIfAborted();
        setStatus(`Scanning chapter ${index + 1} of ${chapters.length}…`);
        try {
          const result: Finding = await request({ action: 'scan', fileName: chapter.fileName }, current.signal);
          current.signal.throwIfAborted();
          setScanDiagnostics(previous => [...previous, { chapterIndex: result.chapterIndex, fileName: result.fileName, diagnostic: result.overrideDiagnostic }]);
          onScanResult?.(result.chapterIndex, result.issues.filter(issue => issue.id !== 'failed-chapter').length);
          if (result.issues.length || result.failed || result.runId) {
            setFindings(previous => [...previous, result]);
            if (result.issues.length && (!result.runId || result.retryRunId)) setSelected(previous => [...previous, result.fileName]);
          }
        } catch (problem) {
          if (current.signal.aborted) throw problem;
          setFindings(previous => [...previous, { ...chapter, title: `Chapter ${chapter.chapterIndex + 1}`, hash: '', issues: [], error: String(problem instanceof Error ? problem.message : problem) }]);
        }
      }
      setScanned(true);
      setStatus(`Checked ${chapters.length} chapter text files. ${catalog.failedJobs?.length ? 'Failed jobs may predate retained output; retry those jobs to capture new failures.' : ''}`);
    } catch (problem) {
      if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Scan failed.');
    } finally { if (controller.current === current) setBusy(false); }
  }

  async function propose(files: string[]) {
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError('');
    try {
      const chapters = findings.filter(row => files.includes(row.fileName) && row.issues.length && (!row.runId || row.retryRunId)).map(row => ({
        fileName: row.fileName, hash: row.hash, retryRunId: row.retryRunId, proposalHash: row.proposalHash, manualPatches: row.issues.flatMap(issue => Object.hasOwn(drafts, `${row.fileName}:${issue.id}`)
          ? [{ id: issue.id, replacement: drafts[`${row.fileName}:${issue.id}`] }] : []),
      }));
      const result = await request({ action: 'queue', requestId: uuidv4(), chapters }, current.signal);
      setJob({ ...selection, id: result.jobId, status: 'queued', progress: 0, total: chapters.length, results: [] });
      setStatus('Repairs queued. You can close this window; proposals will appear as chapters finish. Approval is still required.');
    } catch (problem) { if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Could not queue repairs.'); }
    finally { if (controller.current === current) setBusy(false); }
  }

  async function resumePending() {
    if (!job) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError('');
    try {
      await request({ action: 'resume-repairs', jobId: job.id }, current.signal);
      setJob(previous => previous ? { ...previous, status: 'queued' } : null);
      setStatus('Pending repairs requeued with the selected models and keys. Saved proposals are preserved.');
    } catch (problem) { if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Could not resume repairs.'); }
    finally { if (controller.current === current) setBusy(false); }
  }

  async function retryUnresolved(finding: Finding) {
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError('');
    try {
      const fresh: Finding = await request({ action: 'scan', fileName: finding.fileName }, current.signal);
      if (!fresh.retryRunId || !fresh.issues.length) throw new Error('No pending unresolved proposal remains. Scan again to refresh.');
      const result = await request({ action: 'queue', requestId: uuidv4(), chapters: [{ fileName: fresh.fileName, hash: fresh.hash,
        retryRunId: fresh.retryRunId, proposalHash: fresh.proposalHash }] }, current.signal);
      setJob({ ...selection, id: result.jobId, status: 'queued', progress: 0, total: 1, results: [] });
      setStatus('Retrying unresolved findings from the saved proposal. Existing repairs are preserved.');
    } catch (problem) { if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Could not retry unresolved findings.'); }
    finally { if (controller.current === current) setBusy(false); }
  }

  async function resume(finding: Finding) {
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError('');
    try {
      await request({ action: 'resume', fileName: finding.fileName }, current.signal);
      setStatus('Generation requeued. Completed chapters will be preserved.'); onRecordingQueued();
    } catch (problem) { if (!current.signal.aborted) setError(problem instanceof Error ? problem.message : 'Resume failed.'); }
    finally { if (controller.current === current) setBusy(false); }
  }

  return <>
    <ModalFrame open={open && !reviewRun} onClose={onClose} size="xl">
      <div className="max-h-[90vh] overflow-y-auto rounded-xl border border-line-soft bg-surface p-5 text-text-strong">
        <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">Scan Pronunciation Issues</h2><button onClick={onClose} aria-label="Close pronunciation scan">Close</button></div>
        <p className="my-3 text-sm text-text-soft">Check saved chapters and retained failed output for leftover Greek/Hebrew and broken pronunciation tags. Scanning uses no AI. Proposals use dictionary matches first, and send only affected chapters to Gemini when needed. Review every proposal before recording.</p>
        {config && !activeRepair && <fieldset disabled={busy} className="my-3 space-y-2">
          <label className="block text-sm">Profile<select aria-label="Repair profile" className="ml-2 rounded border border-line-soft bg-surface p-2" value={selection.profileId} onChange={event => {
            const profile = config.profiles.find(item => item.id === event.target.value)!;
            setFallbackModels(undefined);
            setSelection({ profileId: profile.id, aiModel: profile.model, primaryKeyRef: profile.primaryKeyRef, backupKeyRef: profile.backupKeyRef });
            setCustomModel(!PRESET_MODELS.some(model => model.id !== 'custom' && model.id === profile.model));
            setFindings([]); setSelected([]); setDrafts({}); setScanned(false);
          }}>{config.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
          <label className="block text-sm">AI Model<select aria-label="Repair AI model" value={customModel ? 'custom' : selection.aiModel} onChange={event => {
            const model = event.target.value;
            setFallbackModels(undefined);
            setCustomModel(model === 'custom');
            setSelection(previous => ({ ...previous, aiModel: model === 'custom' ? '' : model }));
          }} className="ml-2 rounded border border-line-soft bg-surface p-2">
            {PRESET_MODELS.filter(model => model.id !== 'custom').map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            <option value="custom">Custom model</option>
          </select></label>
          {[0, 1].map(index => <label key={index} className="block text-sm">Fallback model {index + 1}<select aria-label={`Repair fallback model ${index + 1}`} value={effectiveFallbacks[index] || ''} disabled={index === 1 && !effectiveFallbacks[0]} className="ml-2 rounded border border-line-soft bg-surface p-2" onChange={event => {
            const value = event.target.value;
            setFallbackModels(index === 0 ? value ? [value, ...effectiveFallbacks.slice(1).filter(model => model !== value)] : [] : [effectiveFallbacks[0], ...(value ? [value] : [])]);
          }}>
            <option value="">None</option>
            {PRESET_MODELS.filter(model => model.id !== 'custom' && model.id !== selection.aiModel && model.id !== effectiveFallbacks[1 - index]).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select></label>)}
          <p className="text-xs text-text-soft">Fallbacks are tried in order after rate/quota limits (429), overload, or model-unavailable errors. Recovery pauses double from 4 seconds up to 5 minutes across key/model switches; longer server cooldowns are respected. Retries are bounded, so sustained limits can require resuming later.</p>
          {customModel && <label className="block text-sm">Custom model ID<input aria-label="Custom repair AI model" value={selection.aiModel} onChange={event => setSelection(previous => ({ ...previous, aiModel: event.target.value }))} className="ml-2 rounded border border-line-soft bg-surface p-2" /></label>}
          {(['primaryKeyRef', 'backupKeyRef'] as const).map((field, index) => <label key={field} className="block text-sm">{index === 0 ? 'Primary Gemini key' : 'Backup Gemini key'}<select aria-label={index === 0 ? 'Primary Gemini key' : 'Backup Gemini key'} className="ml-2 rounded border border-line-soft bg-surface p-2" value={selection[field]} onChange={event => setSelection(previous => ({ ...previous, [field]: event.target.value }))}>
            <option value="">Not set</option>{config.keySources.map(key => <option key={key.ref} value={key.ref}>{key.label} ({key.masked})</option>)}
          </select></label>)}
          <p className="text-xs text-text-soft">These choices apply only to this repair job, including failed chapters. Add or change saved keys in AI Settings. Scanning and dictionary/manual-only repairs do not call Gemini.</p>
          <label className="block text-sm">Recording voice<select aria-label="Pronunciation repair recording voice" className="ml-2 rounded border border-line-soft bg-surface p-2" value={recordingVoice} onChange={event => { setRecordingVoice(event.target.value); window.localStorage.setItem(`pronunciation-repair-voice:${bookId}`, event.target.value); }}>
            {config.recordingVoices.map(voice => <option key={voice} value={voice}>{voice}{voice === config.recordingVoice ? ' (book voice)' : ''}</option>)}
          </select></label>
          <p className="text-xs text-text-soft">Used when an approved repair is recorded. Audio Drama speaker tags keep their assigned voices; this is the narrator/default voice for untagged text.</p>
        </fieldset>}
        <div className="flex flex-wrap gap-3">
          <button disabled={busy || activeRepair || !config} onClick={() => void scan()} className="rounded bg-accent px-3 py-2 text-background disabled:opacity-50">{scanned ? 'Scan Again' : 'Start Scan'}</button>
          <button disabled={busy || activeRepair || !config || !selected.length} onClick={() => void propose(selected)} className="rounded border border-line-soft px-3 py-2 disabled:opacity-50">Propose Repairs ({selected.length})</button>
          {activeRepair && <button disabled={busy} onClick={() => {
            void request({ action: 'stop', jobId: job.id }, new AbortController().signal).then(() => setStatus('Stop requested. Saved proposals are retained.')).catch(problem => setError(problem.message));
          }} className="rounded border border-line-soft px-3 py-2">Stop repair job</button>}
          {busy && <button onClick={() => { controller.current?.abort(); setStatus('Stopping. Completed results are retained.'); }} className="rounded border border-line-soft px-3 py-2">Stop</button>}
        </div>
        <p role="status" className="my-3 text-sm text-text-soft">{status}</p>
        {job && <p className="text-xs text-text-soft">Job: {job.id} · {job.status} · {job.progress}%{activeRepair ? ' · Wait until the job stops before approving recordings.' : ' · Historical proposal-generation results; current approval and recording status is shown below.'}{job.error ? ` · ${job.error}` : ''}</p>}
        {job && !activeRepair && (job.status === 'error' || job.status === 'paused') && (job.results.length < job.total || job.results.some(result => result.apiBlocked)) && <button disabled={busy} onClick={() => void resumePending()} className="rounded border border-line-soft px-3 py-2">Resume pending repairs</button>}
        {reportJobs.length > 0 && <div className="my-3 space-y-2 text-sm">
          <label>Report for job <select aria-label="Repair report job" value={reportJobId || reportJobs[0].id} onChange={event => setReportJobId(event.target.value)} className="rounded border border-line-soft bg-surface p-1">
            {reportJobs.map(item => <option key={item.id} value={item.id}>{item.id} · {item.status}</option>)}
          </select></label>
          <button disabled={reportDownloading} className="ml-3 text-accent underline disabled:opacity-50" onClick={() => void downloadReport()}>{reportDownloading ? 'Preparing report…' : 'Download repair report'}</button>
          <p className="text-xs text-text-soft">Includes saved errors, finding/replacement details and the Gemini instructions when retained. Older attempts may have only summary errors. Contains book excerpts—review before sharing.</p>
        </div>}
        {job?.aiModel && <p className="text-xs text-text-soft">Job model: {job.aiModel} · Profile: {config?.profiles.find(profile => profile.id === job.profileId)?.name || job.profileId} · Keys: {config?.keySources.find(key => key.ref === job.primaryKeyRef)?.masked || 'Not set'} / {config?.keySources.find(key => key.ref === job.backupKeyRef)?.masked || 'Not set'}</p>}
        {error && <p role="alert" className="my-3 text-danger">{error}</p>}
        <label className="my-4 flex min-h-16 cursor-pointer items-start gap-4 rounded-lg border-2 border-warning bg-warning-wash p-4 text-foreground">
          <input type="checkbox" checked={override} onChange={event => setOverride(event.target.checked)} disabled={approving || busy || activeRepair} className="mt-1 h-7 w-7 shrink-0 accent-accent" />
          <span><span className="block text-lg font-semibold">Override</span><span className="block text-sm">Accept all saved Gemini pronunciation proposals, including those with unresolved pronunciation warnings. Source characters, speaker assignments and markup remain protected. Approval queues replacement audio.</span></span>
        </label>
        <button disabled={approving || busy || activeRepair || !readyRepairs.length} onClick={() => void approveReady()} className="my-3 rounded bg-accent px-3 py-2 text-background disabled:opacity-50">{approving ? 'Approving ready repairs…' : override ? `Accept all proposals with Override (${readyRepairs.length})` : `Approve all ready repairs (${readyRepairs.length})`}</button>
        <button disabled={busy || activeRepair || !failedRecordings.length} onClick={() => void retryFailedRecordings()} className="my-3 rounded bg-accent px-3 py-2 text-background disabled:opacity-50">Retry all failed recordings ({failedRecordings.length})</button>
        <button disabled={busy || activeRepair || !repairs.some(repair => repair.decision === 'approved')} onClick={() => void rememberApproved()} className="ml-3 rounded border border-line-soft px-3 py-2 disabled:opacity-50">Remember approved pronunciations</button>
        <p className="text-xs text-text-soft">Remembering saves reusable Greek/Hebrew corrections to this book’s lexicon profile, not the global dictionary. Contextual forms and conflicting entries stay unchanged.</p>
        {approvalMessage && <p role="status" className="text-sm">{approvalMessage}</p>}
        {scanned && findings.length === 0 && <p>No pronunciation issues found in the checked text.</p>}
        {scanDiagnostics.length > 0 && <details className="my-3 rounded border border-line-soft p-3 text-sm">
          <summary className="cursor-pointer">Override scan diagnostics ({scanDiagnostics.length} chapters)</summary>
          <p className="my-2 text-xs text-text-soft">Results from this scan. Matched means the saved Override applies to this exact text. Text changed means strict warnings apply again. No book excerpts or credentials are included.</p>
          <button className="my-2 text-accent underline" onClick={downloadScanLog}>Download scan log</button>
          <ul className="space-y-2">{scanDiagnostics.map(scan => <li key={scan.fileName}>
            <strong>Chapter {scan.chapterIndex + 1}</strong> · {scan.diagnostic
              ? `${scan.diagnostic.status === 'matched' ? 'Override matched' : scan.diagnostic.status === 'text_changed' ? 'Text changed — Override does not apply' : 'No approved Override'} · ${scan.diagnostic.strictIssueCount} strict findings · ${scan.diagnostic.acknowledgedIssueCount} acknowledged · ${scan.diagnostic.actionableIssueCount} actionable`
              : 'Diagnostics unavailable — the server may need updating.'}
            {scan.diagnostic && <span className="block break-all text-xs text-text-soft">Reference: {scan.diagnostic.requestId}</span>}
          </li>)}</ul>
        </details>}
        <div className="space-y-4">{displayedFindings.map(finding => {
          const repair = repairs.find(item => item.chapterIndex === finding.chapterIndex);
          const currentRun = repair?.runId || finding.runId;
          return <article key={finding.fileName} className="rounded border border-line-soft p-3">
          <div className="flex flex-wrap items-center gap-2">
            <input type="checkbox" aria-label={`Select ${finding.title}`} disabled={busy || activeRepair || !finding.issues.length || Boolean(finding.runId && !finding.retryRunId)} checked={selected.includes(finding.fileName)} onChange={event => setSelected(previous => event.target.checked ? [...previous, finding.fileName] : previous.filter(file => file !== finding.fileName))} />
            <h3 className="font-semibold">{finding.chapterIndex + 1}. {finding.title}</h3>
            <span className="text-sm text-text-soft">{repair?.unresolvedCount ?? finding.issues.length} findings{finding.failed ? ' · Rejected generation output' : ''}</span>
            {repair ? <span className="text-sm text-text-soft">{pronunciationRepairStatusLabel(repair)}</span> : finding.audioStatus && <span className="text-sm text-text-soft">Recording: {finding.audioStatus.replaceAll('_', ' ')}</span>}
            {currentRun && <button disabled={approving} onClick={() => setReviewRun(currentRun)} className="ml-auto text-accent">{repair?.decision === 'approved' ? 'View repair' : 'Review & Approve'}</button>}
            {finding.runId && (!repair || repair.decision === 'pending') && Boolean(repair?.unresolvedCount || finding.unresolvedCount || finding.retryRunId && finding.issues.length || finding.error) && <button disabled={busy || activeRepair} onClick={() => void retryUnresolved(finding)} className="text-accent disabled:opacity-50">Retry unresolved</button>}
          </div>
          {finding.failureError && <p className="mt-2 text-sm text-text-soft">Generation error: {finding.failureError}</p>}
          {finding.error && !(repair?.decision === 'approved' && repair.audioStatus === 'completed') && <p role="alert" className="mt-2 text-sm text-danger">{finding.error}</p>}
          {finding.failed && finding.issues.length === 0 && <p className="mt-2 text-sm text-text-soft">No supported pronunciation defect detected. This failure may need source or speaker review.</p>}
          {finding.issues.map(issue => <details key={issue.id} className="mt-3 rounded border border-line-soft p-2">
            <summary className="cursor-pointer text-sm">{issue.reason} · {issue.replacement !== undefined ? 'Dictionary/formatting repair available' : 'AI or manual review needed'}</summary>
            <pre className="my-2 whitespace-pre-wrap text-xs">{issue.context}</pre>
            <p className="text-xs text-text-soft">Exact affected text: <code>{issue.text}</code></p>
            {issue.replacement !== undefined && <pre className="mt-2 whitespace-pre-wrap text-xs">Suggested: {issue.replacement || '(remove empty punctuation)'}</pre>}
            <button disabled={busy || Boolean(finding.runId)} onClick={() => setDrafts(previous => ({ ...previous, [`${finding.fileName}:${issue.id}`]: issue.replacement ?? issue.text }))} className="mt-2 text-sm text-accent">Enter a manual replacement</button>
            {Object.hasOwn(drafts, `${finding.fileName}:${issue.id}`) && <label className="mt-2 block text-xs">Replacement for this finding
              <textarea disabled={busy || Boolean(finding.runId)} value={drafts[`${finding.fileName}:${issue.id}`]} onChange={event => setDrafts(previous => ({ ...previous, [`${finding.fileName}:${issue.id}`]: event.target.value }))} className="mt-1 w-full rounded border border-line-soft bg-surface p-2 font-mono text-sm" />
            </label>}
          </details>)}
          {finding.jobId && <button disabled={busy} onClick={() => void resume(finding)} className="mt-3 text-sm text-accent disabled:opacity-50">Resume generation after repair recording completes</button>}
        </article>})}</div>
      </div>
    </ModalFrame>
    <BatchRefineReviewModal open={open && Boolean(reviewRun)} onClose={() => { setReviewRun(null); void refreshRepairs().catch(() => {}); }} bookId={bookId} runId={reviewRun} recordingVoice={recordingVoice} overridePronunciationReview={override} onRecordingQueued={() => { onRecordingQueued(); void refreshRepairs().catch(() => {}); }} />
  </>;
}
