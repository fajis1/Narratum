'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { categorizeErrors } from '@/lib/shared/audiobook-error-category';
import { ModalFrame } from '@/components/ui';
import type { AudiobookFailureLogResponse } from '@/app/api/audiobook/failure-log/route';

export interface ChapterErrorLogModalProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  bookTitle?: string | null;
  chapterIndex?: number | null;
  chapterTitle?: string | null;
  jobError?: string | null;
  onRequeue?: () => void;
  onNavigateToChapter?: (chapterIndex: number) => void;
}

export function ChapterErrorLogModal({
  open,
  onClose,
  bookId,
  bookTitle,
  chapterIndex,
  chapterTitle,
  jobError,
  onRequeue,
  onNavigateToChapter,
}: ChapterErrorLogModalProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AudiobookFailureLogResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selectedChapterTab, setSelectedChapterTab] = useState<number | 'all'>('all');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !bookId) return;

    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setCopied(false);

    const url = `/api/audiobook/failure-log?bookId=${encodeURIComponent(bookId)}${chapterIndex != null ? `&chapterIndex=${chapterIndex}` : ''}`;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load error log (${res.status})`);
        return res.json() as Promise<AudiobookFailureLogResponse>;
      })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        if (chapterIndex != null) {
          setSelectedChapterTab(chapterIndex);
        } else if (res.failures.length > 0) {
          setSelectedChapterTab('all');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : 'Failed to retrieve error logs.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, bookId, chapterIndex]);

  const activeFailures = useMemo(() => {
    if (!data) return [];
    if (selectedChapterTab === 'all') return data.failures;
    return data.failures.filter((f) => f.chapterIndex === selectedChapterTab);
  }, [data, selectedChapterTab]);

  const activeReviewFlags = useMemo(() => {
    if (!data) return [];
    if (selectedChapterTab === 'all') return data.reviewFlags;
    return data.reviewFlags.filter((f) => f.chapterIndex === selectedChapterTab);
  }, [data, selectedChapterTab]);

  const handleCopy = () => {
    if (!data) return;
    const report = {
      bookId,
      bookTitle: bookTitle || data.documentTitle,
      jobError: jobError || data.jobError,
      jobStatus: data.jobStatus,
      historySemantics: data.historySemantics || 'retained-diagnostics',
      failures: activeFailures,
      reviewFlags: activeReviewFlags,
      timestamp: new Date().toISOString(),
    };

    navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => {});
  };

  const effectiveJobError = data?.jobStatus === 'completed' ? null : jobError || data?.jobError;

  return (
    <ModalFrame open={open} onClose={onClose} size="xl">
      <div className="bg-surface rounded-xl border border-line-soft overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex justify-between items-center px-5 py-4 border-b border-line-soft bg-surface-raised shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-text-strong flex items-center gap-2 truncate">
              <span>📋</span>
              <span>Audiobook Error & Diagnostic Log</span>
            </h2>
            <p className="text-xs text-text-soft truncate mt-0.5">
              {bookTitle || data?.documentTitle || bookId}
              {chapterIndex != null ? ` · Chapter ${chapterIndex + 1}${chapterTitle ? `: ${chapterTitle}` : ''}` : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-soft hover:text-text-strong text-2xl px-2 leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {loading && (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-text-soft">
              <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs">Loading diagnostic logs from server…</p>
            </div>
          )}

          {fetchError && (
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-sm">
              <p className="font-semibold">Could not load diagnostic log</p>
              <p className="text-xs mt-1">{fetchError}</p>
            </div>
          )}

          {!loading && !fetchError && (
            <>
              <p className="text-xs text-text-muted">
                Retained diagnostic history and review flags may include earlier attempts.
                Latest job status: {data?.jobStatus || 'unavailable'}. These records do not establish that the latest run failed.
              </p>
              {/* Overall Job Error Banner */}
              {effectiveJobError && (
                <div className="p-3.5 rounded-lg bg-red-500/10 border border-red-500/30 text-text-strong text-xs space-y-1">
                  <div className="flex items-center gap-2 text-red-600 dark:text-red-400 font-semibold">
                    <span>⚠️</span>
                    <span>Queue Job Failure</span>
                    {data?.jobStatus && (
                      <span className="uppercase text-[10px] px-1.5 py-0.2 rounded bg-red-500/20">
                        {data.jobStatus}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-[11px] break-words text-red-700 dark:text-red-300">
                    {effectiveJobError}
                  </p>
                </div>
              )}

              {/* Multi-chapter filter tabs if multiple failures exist */}
              {data && data.failures.length > 1 && chapterIndex == null && (
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 border-b border-line-soft text-xs">
                  <button
                    type="button"
                    onClick={() => setSelectedChapterTab('all')}
                    className={`px-3 py-1.5 rounded font-medium shrink-0 transition-colors ${
                      selectedChapterTab === 'all'
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-surface-raised hover:bg-surface-sunken text-text-soft'
                    }`}
                  >
                    All Flagged Chapters ({data.failures.length})
                  </button>
                  {data.failures.map((f) => (
                    <button
                      key={f.chapterIndex}
                      type="button"
                      onClick={() => setSelectedChapterTab(f.chapterIndex)}
                      className={`px-3 py-1.5 rounded font-medium shrink-0 transition-colors flex items-center gap-1.5 ${
                        selectedChapterTab === f.chapterIndex
                          ? 'bg-indigo-600 text-white shadow-sm'
                          : 'bg-surface-raised hover:bg-surface-sunken text-text-soft'
                      }`}
                    >
                      <span>Chunk {f.chapterIndex + 1}</span>
                      <span className="text-[10px] opacity-75 font-mono">({f.errors.length})</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Chapter Failure Entries */}
              {activeFailures.length === 0 && activeReviewFlags.length === 0 && !effectiveJobError && (
                <div className="py-10 text-center text-text-soft text-xs space-y-1">
                  <p className="text-base font-semibold text-text-strong">✨ No retained diagnostic records</p>
                  <p>All chapters have valid recordings or have not logged unrecoverable errors.</p>
                </div>
              )}

              {activeFailures.map((failure) => {
                const diag = categorizeErrors(failure.errors, effectiveJobError, failure.hasDirectorDiagnostic);
                return (
                  <article
                    key={failure.chapterIndex}
                    className="rounded-xl border border-line-soft bg-surface-raised p-4 space-y-3"
                  >
                    {/* Chapter Header & Category */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft pb-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm text-text-strong">
                          Chunk {failure.chapterIndex + 1}: {failure.chapterTitle || `Chapter ${failure.chapterIndex + 1}`}
                        </span>
                        {failure.createdAt && (
                          <span className="text-[11px] text-text-soft">
                            · {new Date(failure.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                          <span>{diag.categoryIcon}</span>
                          <span>{diag.categoryLabel}</span>
                        </span>
                        {onNavigateToChapter && (
                          <button
                            type="button"
                            onClick={() => onNavigateToChapter(failure.chapterIndex)}
                            className="px-2 py-0.5 text-xs font-semibold text-indigo-500 hover:underline"
                          >
                            Open in Editor ↗
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Diagnostic Explanation & Tips */}
                    <div className="p-3 rounded-lg bg-surface border border-line-soft text-xs space-y-2">
                      <p className="text-text-strong leading-relaxed">{diag.explanation}</p>
                      {diag.tips.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-line-soft/60">
                          <p className="font-semibold text-text-soft uppercase tracking-wider text-[10px]">
                            Recommendations to Resolve:
                          </p>
                          <ul className="list-disc pl-4 space-y-0.5 text-text-soft text-[11px]">
                            {diag.tips.map((tip, idx) => (
                              <li key={idx}>{tip}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>

                    {/* Exact Error Messages Log Box */}
                    {failure.hasProviderDiagnostic && (
                      <div className="text-xs text-text-soft rounded-lg border border-line-soft p-3">
                        <span className="font-semibold">Provider summary: </span>
                        {failure.stage || 'Smart Audio'}{failure.provider ? ` · ${failure.provider}` : ''}{failure.model ? ` · ${failure.model}` : ''}{failure.httpStatus ? ` · HTTP ${failure.httpStatus}` : ''}{failure.apiStatus ? ` · ${failure.apiStatus}` : ''}{failure.attempts ? ` · ${failure.attempts} attempts` : ''}
                      </div>
                    )}
                    {failure.errors.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex justify-between items-center text-[10px] font-semibold text-text-soft uppercase tracking-wider">
                          <span>Diagnostic Error Output ({failure.errors.length})</span>
                          <span>Line by Line</span>
                        </div>
                        <div className="p-3 rounded-lg bg-zinc-950 text-zinc-200 border border-zinc-800 font-mono text-[11px] space-y-1 max-h-48 overflow-y-auto">
                          {failure.errors.map((err, idx) => (
                            <div key={idx} className="flex gap-2">
                              <span className="text-red-400 select-none shrink-0">{idx + 1}.</span>
                              <span className="break-words text-red-200">{err}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {failure.chapterIndex != null && failure.hasDirectorDiagnostic && (
                      <a
                        href={`/api/audiobook/director-diagnostics?bookId=${encodeURIComponent(bookId)}&chapterIndex=${failure.chapterIndex}`}
                        download
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-500 text-xs font-semibold"
                      >
                        <span>⬇</span> Download full Gemini response (JSON)
                      </a>
                    )}
                    {failure.chapterIndex != null && failure.hasProviderDiagnostic && (
                      <a href={`/api/audiobook/director-diagnostics?bookId=${encodeURIComponent(bookId)}&chapterIndex=${failure.chapterIndex}&kind=provider`} download
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line-soft text-text-strong text-xs font-semibold">
                        Download Provider / TTS Diagnostic (JSON)
                      </a>
                    )}
                    {diag.category === 'drama_director' && failure.chapterIndex != null && !failure.hasDirectorDiagnostic && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-300">
                        No retained Gemini response is available for this failure. Re-recording will save the full response if validation fails again.
                      </p>
                    )}
                  </article>
                );
              })}

              {/* Segment Review Flags Breakdown */}
              {activeReviewFlags.length > 0 && (
                <div className="rounded-xl border border-amber-300/30 bg-amber-50/50 dark:bg-amber-950/20 p-4 space-y-2">
                  <h3 className="text-xs font-bold text-amber-900 dark:text-amber-200 flex items-center gap-1.5">
                    <span>🚩</span>
                    <span>Segment Performance Flags ({activeReviewFlags.length})</span>
                  </h3>
                  <div className="space-y-2">
                    {activeReviewFlags.map((flag) => (
                      <div
                        key={flag.id}
                        className="rounded border border-amber-700/20 bg-surface p-2.5 text-xs text-text-strong space-y-1"
                      >
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-semibold">
                            Chapter {(flag.chapterIndex ?? 0) + 1}
                            {flag.speaker ? ` · ${flag.speaker}` : ''}
                          </span>
                          {flag.kind && (
                            <span className="capitalize px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[10px]">
                              {flag.kind.replaceAll('-', ' ')}
                            </span>
                          )}
                        </div>
                        {flag.sourceText && (
                          <p className="text-text-soft line-clamp-2 italic text-[11px]">
                            “{flag.sourceText}”
                          </p>
                        )}
                        {flag.reason && (
                          <p className="text-amber-700 dark:text-amber-300 text-[11px] font-medium">
                            {flag.reason}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3.5 border-t border-line-soft bg-surface-raised flex items-center justify-between gap-2 shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              disabled={loading || !data}
              className="px-3 py-1.5 rounded-lg border border-line-soft bg-surface hover:bg-surface-sunken text-text-strong text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
              title="Copy complete structured error diagnostics to clipboard"
            >
              <span>{copied ? '✓ Copied!' : '📋 Copy Diagnostic Log'}</span>
            </button>

            {onRequeue && (
              <button
                type="button"
                onClick={onRequeue}
                className="px-3 py-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-500 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                title="Retry queued audiobook generation"
              >
                <span>🔄 Requeue Audiobook</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {chapterIndex != null && onNavigateToChapter && (
              <button
                type="button"
                onClick={() => onNavigateToChapter(chapterIndex)}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors"
              >
                Review & Edit Chunk {chapterIndex + 1} 🎙️
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg border border-line-soft bg-surface hover:bg-surface-sunken text-text-strong text-xs font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </ModalFrame>
  );
}
