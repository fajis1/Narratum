'use client';

import { useState, useEffect } from 'react';
import { readAudiobookGeminiCooldown } from '@/lib/shared/audiobook-gemini-cooldown';
import { AudiobookGeminiCooldownNotice } from '@/components/audiobooks/AudiobookGeminiCooldownNotice';
import { MultiVoiceCharacterModal } from '@/components/doclist/MultiVoiceCharacterModal';
import { ChapterErrorLogModal } from '@/components/audiobooks/ChapterErrorLogModal';
import {
  AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS,
  isGeminiRateLimitPause,
  resolveAudiobookJobDescriptiveState,
} from '@/lib/shared/audiobook-job-status';
import { DRAMA_GEMINI_TTS_WORKER_MODE, WAITING_FOR_VOICES_STATUS } from '@/lib/shared/multi-voice';
import { AUDIOBOOK_WAITING_FOR_GPU_PHASE } from '@/lib/shared/audiobook-runtime-phase';

interface Job {
  id: string;
  documentId: string;
  status: string;
  createdAt: number;
  startedAt?: number;
  updatedAt?: number;
  progress?: number;
  error?: string;
  documentTitle?: string;
  settingsJson?: unknown;
  globalQueuePosition?: number;
  phase?: string | null;
  gpuQueueState?: string | null;
}

type QueueFilter = 'active' | 'all' | 'completed' | 'failed';

function jobProfileId(job: Job): string {
  let settings = job.settingsJson;
  if (typeof settings === 'string') {
    try { settings = JSON.parse(settings); } catch { return ''; }
  }
  return settings && typeof settings === 'object'
    && typeof (settings as { smartAudioProfileId?: unknown }).smartAudioProfileId === 'string'
    ? (settings as { smartAudioProfileId: string }).smartAudioProfileId
    : '';
}

function isActiveJob(job: Job): boolean {
  return [
    'queued',
    'running',
    'waiting_for_pdf',
    WAITING_FOR_VOICES_STATUS,
    'paused',
    AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS,
  ].includes(job.status);
}

function isCompletedJob(job: Job): boolean {
  return resolveAudiobookJobDescriptiveState(job).category === 'completed';
}

function isFailedJob(job: Job): boolean {
  return resolveAudiobookJobDescriptiveState(job).category === 'error';
}

export function JobsInlineView() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeGlobalJob, setActiveGlobalJob] = useState<{
    startedAt?: number;
    updatedAt?: number;
    progress?: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [castingJob, setCastingJob] = useState<Job | null>(null);
  const [errorLogJob, setErrorLogJob] = useState<Job | null>(null);
  const [filter, setFilter] = useState<QueueFilter>('active');
  const [hasInitializedFilter, setHasInitializedFilter] = useState(false);
  const [profileWorkerModes, setProfileWorkerModes] = useState<Record<string, string>>({});

  const onRequeueJob = async (id: string) => {
    try {
      setActionError(null);
      const response = await fetch('/api/audiobooks/queue', { method: 'PUT', body: JSON.stringify({ id }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Could not retry missing chapters.'); }
      await fetchJobs();
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not retry missing chapters.'); }
  };

  const onRequeueAllFailed = async () => {
    try {
      setClearing(true);
      await fetch('/api/audiobooks/queue', { method: 'PUT', body: JSON.stringify({ requeueAllFailed: true }) });
      await fetchJobs();
    } catch {} finally {
      setClearing(false);
    }
  };

  const onCancelJob = async (id: string) => {
    try {
      await fetch(`/api/audiobooks/queue?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      await fetchJobs();
    } catch {}
  };

  const onClearJobs = async (clearType: 'completed' | 'failed' | 'finished') => {
    try {
      setClearing(true);
      await fetch(`/api/audiobooks/queue?clear=${encodeURIComponent(clearType)}`, { method: 'DELETE' });
      await fetchJobs();
    } catch {} finally {
      setClearing(false);
    }
  };

  const onTogglePauseJob = async (id: string, action: 'pause' | 'resume') => {
    try {
      setActionError(null);
      const response = await fetch('/api/audiobooks/queue', { method: 'PATCH', body: JSON.stringify({ id, action }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Could not update the job.'); }
      await fetchJobs();
    } catch (error) { setActionError(error instanceof Error ? error.message : 'Could not update the job.'); }
  };

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const getRemainingMs = (now: number, startedAt: number, updatedAt: number, progressPercent: number) => {
    const activeMsAtLastUpdate = Math.max(0, updatedAt - startedAt);
    if (progressPercent <= 0 || activeMsAtLastUpdate <= 0) return -1;
    const totalEstimatedMs = activeMsAtLastUpdate / (progressPercent / 100);
    const elapsedSinceStart = now - startedAt;
    return Math.max(0, totalEstimatedMs - elapsedSinceStart);
  };

  const formatMs = (remainingMs: number) => {
    if (remainingMs < 0) return 'Calculating...';
    if (remainingMs === 0) return 'Almost done...';
    const remainingMins = Math.floor(remainingMs / 60000);
    const remainingSecs = Math.floor((remainingMs % 60000) / 1000);
    if (remainingMins > 60) {
      const hrs = Math.floor(remainingMins / 60);
      const mins = remainingMins % 60;
      return `${hrs}h ${mins}m`;
    }
    return `${remainingMins}m ${remainingSecs}s`;
  };

  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/audiobooks/queue');
      if (res.ok) {
        const data = await res.json();
        const incomingJobs: Job[] = data.jobs || [];
        setJobs(incomingJobs);
        setActiveGlobalJob(data.activeGlobalJob || null);
        if (!hasInitializedFilter) {
          const hasActive = incomingJobs.some(isActiveJob);
          setFilter(hasActive ? 'active' : 'all');
          setHasInitializedFilter(true);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/tts-settings', { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => {
        if (cancelled || !Array.isArray(body?.smartAudioProfiles)) return;
        setProfileWorkerModes(Object.fromEntries(body.smartAudioProfiles.flatMap((profile: { id?: unknown; workerMode?: unknown }) => (
          typeof profile.id === 'string' && typeof profile.workerMode === 'string'
            ? [[profile.id, profile.workerMode]]
            : []
        ))));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const activeJobs = jobs.filter(isActiveJob);
  const completedJobs = jobs.filter(isCompletedJob);
  const failedJobs = jobs.filter(isFailedJob);
  const finishedJobsCount = completedJobs.length + failedJobs.length;

  const filteredJobs = (() => {
    let list: Job[];
    switch (filter) {
      case 'active':
        list = activeJobs;
        break;
      case 'completed':
        list = completedJobs;
        break;
      case 'failed':
        list = failedJobs;
        break;
      case 'all':
      default:
        list = jobs;
        break;
    }

    const statusWeight = (s: string) => {
      switch (s) {
        case 'running': return 1;
        case AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS: return 2;
        case WAITING_FOR_VOICES_STATUS: return 3;
        case 'waiting_for_pdf': return 4;
        case 'queued': return 5;
        case 'paused': return 6;
        case 'error': return 7;
        case 'completed': return 8;
        default: return 9;
      }
    };

    return [...list].sort((a, b) => {
      const wa = statusWeight(a.status);
      const wb = statusWeight(b.status);
      if (wa !== wb) return wa - wb;
      if (wa <= 6) return (a.createdAt || 0) - (b.createdAt || 0);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
  })();

  return (
    <>
    <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-8">
      {actionError && <p role="alert" className="text-danger">{actionError}</p>}
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-line">
          <div>
            <h1 className="text-2xl font-semibold">Background Audiobooks Queue</h1>
            <p className="text-xs text-soft mt-1">
              Monitor active generation progress, position in line, and job history.
            </p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {completedJobs.length > 0 && (
              <button
                onClick={() => onClearJobs('completed')}
                disabled={clearing}
                className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-line bg-surface hover:bg-surface-hover text-foreground flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                title="Remove completed audiobooks from this history list"
              >
                <span>🧹 Clear Completed ({completedJobs.length})</span>
              </button>
            )}

            {failedJobs.length > 0 && (
              <>
                <button
                  onClick={onRequeueAllFailed}
                  disabled={clearing}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-accent-line bg-accent-wash hover:bg-accent-wash text-accent flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                  title="Retry all failed jobs"
                >
                  <span>Requeue All Errors ({failedJobs.length})</span>
                </button>
                <button
                  onClick={() => onClearJobs('failed')}
                  disabled={clearing}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-danger bg-danger-wash hover:bg-danger-wash text-danger flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                  title="Dismiss all failed jobs from queue history"
                >
                  <span>Dismiss All Errors ({failedJobs.length})</span>
                </button>
              </>
            )}

            {completedJobs.length > 0 && failedJobs.length > 0 && (
              <button
                onClick={() => onClearJobs('finished')}
                disabled={clearing}
                className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-line bg-surface-sunken hover:bg-surface text-soft hover:text-foreground flex items-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                title="Clear all completed and failed jobs"
              >
                <span>Clear All Finished ({finishedJobsCount})</span>
              </button>
            )}
          </div>
        </div>

        {/* Tab Filters */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilter('active')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filter === 'active'
                ? 'bg-accent text-white shadow-sm'
                : 'bg-surface hover:bg-surface-hover text-soft hover:text-foreground border border-line'
            }`}
          >
            Active ({activeJobs.length})
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filter === 'all'
                ? 'bg-accent text-white shadow-sm'
                : 'bg-surface hover:bg-surface-hover text-soft hover:text-foreground border border-line'
            }`}
          >
            All ({jobs.length})
          </button>
          <button
            onClick={() => setFilter('completed')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filter === 'completed'
                ? 'bg-accent text-white shadow-sm'
                : 'bg-surface hover:bg-surface-hover text-soft hover:text-foreground border border-line'
            }`}
          >
            Completed ({completedJobs.length})
          </button>
          <button
            onClick={() => setFilter('failed')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filter === 'failed'
                ? 'bg-accent text-white shadow-sm'
                : 'bg-surface hover:bg-surface-hover text-soft hover:text-foreground border border-line'
            }`}
          >
            Failed ({failedJobs.length})
          </button>
        </div>

        {loading ? (
          <div className="text-soft">Loading jobs...</div>
        ) : filteredJobs.length === 0 ? (
          <div className="text-soft bg-surface-sunken p-8 rounded-lg text-center border border-line">
            {filter === 'active' && jobs.length > 0 ? (
              <div className="space-y-2">
                <p>No audiobooks are currently running or queued.</p>
                <div className="flex justify-center gap-2 pt-2">
                  <button onClick={() => setFilter('completed')} className="text-xs text-accent hover:underline">
                    View Completed ({completedJobs.length})
                  </button>
                  <span className="text-faint">&bull;</span>
                  <button onClick={() => setFilter('all')} className="text-xs text-accent hover:underline">
                    View All History ({jobs.length})
                  </button>
                </div>
              </div>
            ) : filter === 'completed' ? (
              'No completed jobs.'
            ) : filter === 'failed' ? (
              'No failed jobs.'
            ) : (
              'No background jobs in the queue.'
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {filteredJobs.map((job) => {
              const descriptiveState = resolveAudiobookJobDescriptiveState(job);
              const isQueued = job.status === 'queued' || job.status === 'waiting_for_pdf';
              const isPauseRequested = job.status === AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS;
              const isWaitingForVoices = job.status === WAITING_FOR_VOICES_STATUS
                || (job.status === 'queued' && job.error === 'waiting_for_voices');
              const geminiCooldown = readAudiobookGeminiCooldown(job.settingsJson, job.status);
              const isWaitingForGpu = job.phase === AUDIOBOOK_WAITING_FOR_GPU_PHASE;
              const isGeminiDramaJob = profileWorkerModes[jobProfileId(job)] === DRAMA_GEMINI_TTS_WORKER_MODE;
              const isGeminiDramaStarting = isGeminiDramaJob
                && job.status === 'running'
                && (job.progress || 0) === 0
                && !job.error;
              const globalPosition = job.globalQueuePosition;
              
              let queueEtaStr = '';
              if (isQueued && globalPosition && activeGlobalJob && typeof activeGlobalJob.startedAt === 'number' && typeof activeGlobalJob.progress === 'number' && activeGlobalJob.progress > 0) {
                const activeStartedAt = activeGlobalJob.startedAt;
                const activeRemainingMs = getRemainingMs(now, activeStartedAt, activeGlobalJob.updatedAt || activeStartedAt, activeGlobalJob.progress);
                if (activeRemainingMs >= 0) {
                  const activeTotalMs = activeRemainingMs + (now - activeStartedAt);
                  const myWaitMs = activeRemainingMs + (activeTotalMs * (globalPosition - 1));
                  queueEtaStr = formatMs(myWaitMs);
                }
              }

              return (
                <div key={job.id} className="bg-surface p-4 rounded-lg border border-line shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-medium text-foreground truncate" title={job.documentTitle || job.documentId}>
                      {job.documentTitle || `Document ID: ${job.documentId.substring(0, 8)}...`}
                    </h3>
                    <div className="text-sm text-soft mt-2 flex flex-col gap-2">
                      <div className="flex items-center flex-wrap gap-y-1">
                        Status:{' '}
                        <span className={`uppercase font-semibold ml-1 ${
                          descriptiveState.category === 'waiting' || descriptiveState.badgeText === 'Incomplete' ? 'text-warning' : isCompletedJob(job)
                            ? 'text-success'
                            : job.status === 'error'
                            ? 'text-danger'
                            : job.status === 'running'
                            ? 'text-accent'
                            : 'text-warning'
                        }`}>
                          {descriptiveState.badgeText}
                        </span>
                        {geminiCooldown && <span className="ml-3 text-warning">{Math.round(job.progress || 0)}% complete · progress preserved</span>}
                        {isWaitingForGpu && (
                          <span className="ml-2 uppercase font-semibold text-warning">· Waiting for GPU</span>
                        )}
                        {isQueued && globalPosition ? (
                          <span className="ml-3 px-2 py-0.5 rounded-full bg-surface-sunken border border-line text-xs">Queue Position: #{globalPosition}</span>
                        ) : null}
                        {queueEtaStr ? (
                          <span className="ml-3 text-faint">
                            (~{queueEtaStr} remaining before processing)
                          </span>
                        ) : null}
                        {!geminiCooldown && !isWaitingForGpu && (job.status === 'running' || isPauseRequested) && job.startedAt && typeof job.progress === 'number' ? (
                          <span className="ml-3 text-faint">
                            ({Math.round(job.progress || 0)}% done &bull; ~{formatMs(getRemainingMs(now, job.startedAt, job.updatedAt || job.startedAt, job.progress))} remaining)
                          </span>
                        ) : null}
                      </div>
                      
                      {(job.status === 'running' || isPauseRequested) && (
                        <div className="w-full max-w-sm h-1.5 bg-surface-sunken rounded-full overflow-hidden mt-1 border border-line">
                          <div 
                            className="h-full bg-accent" 
                            style={{ width: `${Math.round(job.progress || 0)}%`, transition: 'width 1000ms linear' }}
                          />
                        </div>
                      )}
                      {isWaitingForGpu && (
                        <p className="max-w-xl text-warning">
                          Your audiobook progress is preserved. Kokoro will continue automatically when the shared GPU is ready.
                        </p>
                      )}
                      {geminiCooldown && <AudiobookGeminiCooldownNotice cooldown={geminiCooldown} />}
                      {!geminiCooldown && isGeminiDramaStarting && (
                        <div className="max-w-2xl rounded border border-warning/30 bg-warning/10 p-3 text-warning">
                          <p className="font-semibold">Waiting for Google Gemini to finish the first Drama chapter</p>
                          <p className="mt-1 text-xs leading-relaxed">
                            Progress remains at 0% until the first complete chapter is returned. Google&apos;s free-tier API can be overloaded or rate-limited, and OpenReader is retrying automatically. If this profile uses a free-tier key, adding a paid Gemini API key in Smart Audio Settings generally provides more capacity and may start the audiobook sooner.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="sm:text-right text-xs text-soft flex flex-col sm:items-end justify-between gap-2">
                    <div>
                      <span>Created: {new Date(job.createdAt).toLocaleString()}</span>
                      {job.error && !isWaitingForVoices && (
                        <div className="mt-1">
                          {isGeminiRateLimitPause(job.error) ? (
                            <div className="bg-warning/10 border border-warning/30 rounded p-2 text-warning max-w-md text-left">
                              <p className="font-semibold flex items-center gap-1">
                                <span>⏸️ Paused (Rate Limit / Quota)</span>
                              </p>
                              <p className="mt-0.5 break-words">{job.error}</p>
                            </div>
                          ) : (
                            <>
                              <p className="text-danger max-w-md break-words">Error: {job.error}</p>
                              <button
                                type="button"
                                onClick={() => setErrorLogJob(job)}
                                className="mt-1 text-accent font-semibold hover:underline flex items-center gap-1 text-xs"
                                title="View detailed validation errors and diagnostic logs"
                              >
                                <span>📋 View Error Log & Diagnostics</span>
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {isPauseRequested && <p className="mt-1 text-warning">Pause requested. The worker will stop after its current step.</p>}
                      {isWaitingForVoices && <p className="mt-1 text-warning">Character casting review is required before generation can continue.</p>}
                    </div>

                    <div className="flex gap-2 justify-end items-center flex-wrap pt-1">
                      {isWaitingForVoices && jobProfileId(job) && (
                        <button onClick={() => setCastingJob(job)} className="text-accent font-semibold hover:underline bg-surface-sunken border border-accent px-2 py-1 rounded">
                          Review Character Voices
                        </button>
                      )}
                      {!isWaitingForVoices && ['queued', 'running', AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS, 'paused'].includes(job.status) && (
                        <a href={`/listen/${job.documentId}`} className="text-accent font-semibold hover:underline bg-surface-sunken border border-accent px-2 py-1 rounded">
                          Review Progress
                        </a>
                      )}
                      {isCompletedJob(job) && (
                        <a href={`/listen/${job.documentId}`} className="text-accent font-semibold hover:underline bg-surface-sunken border border-accent px-2 py-1 rounded">
                          Listen / Download
                        </a>
                      )}
                      {!isWaitingForVoices && !isGeminiRateLimitPause(job.error) && ['queued', 'running', 'waiting_for_pdf'].includes(job.status) && (
                        <button onClick={() => { onTogglePauseJob(job.id, 'pause'); }} className="text-warning font-semibold hover:underline bg-surface-sunken border border-warning px-2 py-1 rounded">
                          Pause
                        </button>
                      )}
                      {(job.status === 'paused' || (job.status === 'queued' && isGeminiRateLimitPause(job.error))) && (
                        <button onClick={() => { onTogglePauseJob(job.id, 'resume'); }} className="text-success font-semibold hover:underline bg-surface-sunken border border-success px-2 py-1 rounded">
                          Resume
                        </button>
                      )}
                      {(job.status === 'error' || (job.status === 'completed' && !!job.error)) && (
                        <>
                          <button
                            type="button"
                            onClick={() => setErrorLogJob(job)}
                            className="text-warning font-semibold hover:underline bg-surface-sunken border border-warning px-2 py-1 rounded flex items-center gap-1"
                            title="Inspect chapter validation errors and failure details"
                          >
                            <span>📋 Error Log</span>
                          </button>
                          <a
                            href={`/listen/${job.documentId}?filter=needs_review`}
                            className="text-accent font-semibold hover:underline bg-surface-sunken border border-accent px-2 py-1 rounded"
                          >
                            Review Chapters
                          </a>
                          <button onClick={() => { onRequeueJob(job.id); }} className="text-accent font-semibold hover:underline bg-surface-sunken border border-accent px-2 py-1 rounded">
                            Retry Missing Chapters
                          </button>
                        </>
                      )}
                      <button onClick={() => { onCancelJob(job.id); }} className="text-danger font-semibold hover:underline bg-surface-sunken border border-danger px-2 py-1 rounded">
                        {job.status === 'error' ? 'Dismiss' : job.status === 'completed' ? 'Clear' : 'Cancel Generation'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
    {castingJob && jobProfileId(castingJob) && (
      <MultiVoiceCharacterModal
        documentId={castingJob.documentId}
        profileId={jobProfileId(castingJob)}
        jobId={castingJob.id}
        isOpen={true}
        onClose={() => setCastingJob(null)}
        onComplete={async () => {
          setCastingJob(null);
          await fetchJobs();
        }}
      />
    )}
    {errorLogJob && (
      <ChapterErrorLogModal
        open={true}
        onClose={() => setErrorLogJob(null)}
        bookId={errorLogJob.documentId}
        bookTitle={errorLogJob.documentTitle}
        jobError={errorLogJob.error}
        onRequeue={() => {
          onRequeueJob(errorLogJob.id);
          setErrorLogJob(null);
        }}
        onNavigateToChapter={(idx) => {
          window.location.href = `/listen/${errorLogJob.documentId}?chapter=${idx}&filter=needs_review`;
        }}
      />
    )}
    </>
  );
}
