'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { Button, Input, ModalFrame } from '@/components/ui';

export interface AudiobookshelfModalProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  userId?: string;
  initialTitle?: string;
  initialAuthor?: string;
  documentType?: string;
  onReviewChapters?: () => void;
}

interface AudiobookshelfFolder {
  id: string;
  fullPath: string;
}

interface AudiobookshelfLibrary {
  id: string;
  name: string;
  mediaType: string;
  folders: AudiobookshelfFolder[];
}

interface AudiobookshelfConfigResponse {
  configured: boolean;
  url?: string;
  defaultLibraryId?: string;
  defaultFolderId?: string;
  autoDetectMetadata?: boolean;
  libraries?: AudiobookshelfLibrary[];
  message?: string;
}

interface MatchCandidate {
  id: string;
  title: string;
  author: string;
  folderName: string;
  hasAudio: boolean;
  hasEbook: boolean;
}

interface MatchResult {
  matchFound: boolean;
  candidate: MatchCandidate | null;
  confidence: number;
  reasoning: string;
}

const AI_MODEL_OPTIONS = [
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite (Default)' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash (High Accuracy)' },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
];

export function AudiobookshelfModal({
  open,
  onClose,
  bookId,
  userId,
  initialTitle = '',
  initialAuthor = '',
  documentType = 'pdf',
  onReviewChapters,
}: AudiobookshelfModalProps) {
  const router = useRouter();
  const [config, setConfig] = useState<AudiobookshelfConfigResponse | null>(null);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [title, setTitle] = useState(initialTitle);
  const [author, setAuthor] = useState(initialAuthor);
  const [series, setSeries] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [includeCompanion, setIncludeCompanion] = useState(true);

  const [aiModel, setAiModel] = useState('gemini-3.1-flash-lite');
  const [isCheckingMatch, setIsCheckingMatch] = useState(false);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [mergeIntoExisting, setMergeIntoExisting] = useState(true);

  const [isInferring, setIsInferring] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Sync initial title/author when opening
  useEffect(() => {
    if (open) {
      if (initialTitle) setTitle(initialTitle);
      if (initialAuthor) setAuthor(initialAuthor);
      setStatusMessage(null);
      setMatchResult(null);
      setUploadError(null);
    } else {
      setUploadError(null);
    }
  }, [open, initialTitle, initialAuthor]);

  const runCheckExistingBook = useCallback(
    async (targetTitle: string, targetAuthor?: string, targetLibId?: string, modelToUse = aiModel) => {
      if (!bookId || !targetTitle.trim()) return;
      setIsCheckingMatch(true);
      try {
        const res = await fetch('/api/audiobook/audiobookshelf/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bookId,
            userId: userId || undefined,
            libraryId: targetLibId || libraryId || undefined,
            title: targetTitle.trim(),
            author: targetAuthor?.trim() || undefined,
            model: modelToUse,
          }),
        });
        const data = await res.json();
        if (res.ok && data) {
          setMatchResult(data);
          if (data.matchFound) {
            setMergeIntoExisting(true);
          }
        }
      } catch (err) {
        console.warn('Audiobookshelf match check failed:', err);
      } finally {
        setIsCheckingMatch(false);
      }
    },
    [bookId, userId, libraryId, aiModel],
  );

  // Load ABS config when modal opens
  useEffect(() => {
    if (!open) return;

    let active = true;
    setIsLoadingConfig(true);

    fetch('/api/audiobook/audiobookshelf')
      .then((res) => res.json())
      .then((data: AudiobookshelfConfigResponse) => {
        if (!active) return;
        setConfig(data);
        if (data.configured) {
          const libs = data.libraries || [];
          const initialLibId = data.defaultLibraryId || libs[0]?.id || '';
          setLibraryId(initialLibId);

          const currentLib = libs.find((l) => l.id === initialLibId);
          const initialFolderId = data.defaultFolderId || currentLib?.folders?.[0]?.id || '';
          setFolderId(initialFolderId);

          // If auto-detect metadata is enabled, trigger Gemini inference
          if (data.autoDetectMetadata) {
            void runInferMetadata(initialLibId);
          } else if (title.trim()) {
            void runCheckExistingBook(title, author, initialLibId);
          }
        }
      })
      .catch((err) => {
        if (!active) return;
        console.error('Failed to load Audiobookshelf config:', err);
      })
      .finally(() => {
        if (active) setIsLoadingConfig(false);
      });

    return () => {
      active = false;
    };
  }, [open]);

  const libraries = useMemo(() => config?.libraries || [], [config]);

  const folders = useMemo(() => {
    const lib = libraries.find((l) => l.id === libraryId);
    return lib?.folders || [];
  }, [libraries, libraryId]);

  const candidateHasEbook = useMemo(
    () => Boolean(mergeIntoExisting && matchResult?.matchFound && matchResult.candidate?.hasEbook),
    [mergeIntoExisting, matchResult],
  );

  const handleLibraryChange = (newLibId: string) => {
    setLibraryId(newLibId);
    const lib = libraries.find((l) => l.id === newLibId);
    if (lib && lib.folders.length > 0) {
      setFolderId(lib.folders[0].id);
    } else {
      setFolderId('');
    }
    if (title.trim()) {
      void runCheckExistingBook(title, author, newLibId);
    }
  };

  const runInferMetadata = useCallback(
    async (libIdOverride?: string) => {
      if (!bookId) return;
      setIsInferring(true);
      setStatusMessage('Analyzing document with Gemini to infer canonical title and metadata...');

      try {
        const queryParams = new URLSearchParams({ bookId });
        if (userId) queryParams.set('userId', userId);
        const res = await fetch(`/api/audiobook/metadata/infer-title?${queryParams.toString()}`);
        const data = await res.json();
        if (res.ok && data.success && data.metadata) {
          const meta = data.metadata;
          const nextTitle = meta.title || title;
          const nextAuthor = meta.author || author;
          if (meta.title) setTitle(meta.title);
          if (meta.author) setAuthor(meta.author);
          if (meta.series) {
            const seriesStr = meta.seriesIndex ? `${meta.series} #${meta.seriesIndex}` : meta.series;
            setSeries(seriesStr);
          }
          toast.success('Inferred title and author with Gemini!');
          setStatusMessage(null);
          void runCheckExistingBook(nextTitle, nextAuthor, libIdOverride || libraryId);
        } else {
          setStatusMessage(null);
          if (title.trim()) {
            void runCheckExistingBook(title, author, libIdOverride || libraryId);
          }
        }
      } catch (err) {
        console.warn('Metadata inference failed:', err);
        setStatusMessage(null);
      } finally {
        setIsInferring(false);
      }
    },
    [bookId, userId, title, author, libraryId, runCheckExistingBook],
  );

  const handleUpload = async () => {
    if (!title.trim()) {
      toast.error('Please specify a title for the audiobook.');
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setStatusMessage('Assembling audio and uploading to Audiobookshelf... (this may take a minute)');

    try {
      const candidateHasEbook = Boolean(mergeIntoExisting && matchResult?.matchFound && matchResult.candidate?.hasEbook);
      const isUnifiedMerge = mergeIntoExisting && matchResult?.matchFound && Boolean(matchResult.candidate);
      const effectiveIncludeCompanion = candidateHasEbook ? false : includeCompanion;
      const res = await fetch('/api/audiobook/audiobookshelf', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bookId,
          userId: userId || undefined,
          title: title.trim(),
          author: author.trim() || undefined,
          series: series.trim() || undefined,
          includeCompanionDocument: effectiveIncludeCompanion,
          libraryId: libraryId || undefined,
          folderId: folderId || undefined,
          smartMatchExistingBook: mergeIntoExisting,
          targetItemId: isUnifiedMerge ? matchResult?.candidate?.id : undefined,
          targetFolderName: isUnifiedMerge ? matchResult?.candidate?.folderName : undefined,
          model: aiModel,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to upload audiobook to Audiobookshelf');
      }

      toast.success(data.message || 'Audiobook successfully sent to Audiobookshelf!');
      onClose();
    } catch (err) {
      console.error('Audiobookshelf upload failed:', err);
      const msg = (err as Error).message || 'Failed to send audiobook to Audiobookshelf';
      setUploadError(msg);
      toast.error(msg);
      setStatusMessage(null);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <ModalFrame open={open} onClose={isUploading ? () => {} : onClose} size="lg">
      <div className="flex flex-col space-y-4 text-left p-6">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-line-soft pb-3">
          <div className="flex items-center space-x-2">
            <div className="rounded-full bg-accent/10 p-2 text-accent">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Add to Audiobookshelf</h2>
              <p className="text-xs text-muted">
                Export complete audiobook and companion document directly to your Audiobookshelf server.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={isUploading}
            className="text-muted hover:text-foreground p-1 text-lg rounded leading-none transition-colors"
          >
            &times;
          </button>
        </div>

        {/* Content */}
        {isLoadingConfig ? (
          <div className="py-8 text-center text-sm text-muted animate-pulse">
            Connecting to Audiobookshelf...
          </div>
        ) : config && !config.configured ? (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 p-4 text-xs text-amber-300 space-y-2">
            <div className="font-semibold text-sm">Audiobookshelf is not configured</div>
            <p>
              Please enter your Audiobookshelf Server URL and API Token in Admin Settings to enable direct exports.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {uploadError && (
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs space-y-2 text-text-strong">
                <div className="flex items-start gap-2">
                  <span className="text-amber-500 font-bold text-sm leading-none mt-0.5">⚠️</span>
                  <div className="flex-1">
                    <p className="font-semibold text-amber-500">Upload Blocked</p>
                    <p className="text-text-soft mt-0.5">{uploadError}</p>
                  </div>
                </div>
                {uploadError.includes('require review') && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        if (onReviewChapters) {
                          onReviewChapters();
                        } else {
                          router.push(`/listen/${encodeURIComponent(bookId)}?filter=needs_review`);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs shadow-xs transition-colors"
                    >
                      <span>🔍</span> Open & Filter Chapters Needing Review
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* Server connection pill */}
            <div className="flex items-center justify-between text-xs px-3 py-2 rounded-md bg-surface-raised border border-line-soft">
              <div className="flex items-center gap-1.5 text-foreground">
                <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                <span className="font-medium">Audiobookshelf:</span>
                <span className="text-muted truncate max-w-[240px]">{config?.url}</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void runInferMetadata()}
                disabled={isInferring || isUploading}
                className="text-accent hover:text-accent font-medium flex items-center gap-1"
              >
                {isInferring ? 'Inferring...' : '✨ Infer with Gemini'}
              </Button>
            </div>

            {/* Status message banner */}
            {statusMessage && (
              <div className="rounded-md bg-accent/10 border border-accent/20 px-3 py-2 text-xs text-accent flex items-center gap-2">
                <svg className="animate-spin h-3.5 w-3.5 text-accent" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <span>{statusMessage}</span>
              </div>
            )}

            {/* Title field */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">Book Title</label>
                {isInferring && <span className="text-[11px] text-accent">Detecting...</span>}
              </div>
              <Input
                type="text"
                placeholder="The Way of Kings"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={isUploading}
              />
            </div>

            {/* Author field */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Author</label>
              <Input
                type="text"
                placeholder="Brandon Sanderson"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                disabled={isUploading}
              />
            </div>

            {/* Series field */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">Series (optional)</label>
              <Input
                type="text"
                placeholder="The Stormlight Archive #1"
                value={series}
                onChange={(e) => setSeries(e.target.value)}
                disabled={isUploading}
              />
            </div>

            {/* AI Model selector */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-foreground">AI Matching Model</label>
                <span className="text-[11px] text-muted">For existing book detection</span>
              </div>
              <select
                className="w-full rounded-md border border-line-soft bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                value={aiModel}
                onChange={(e) => {
                  const newModel = e.target.value;
                  setAiModel(newModel);
                  if (title.trim()) {
                    void runCheckExistingBook(title, author, libraryId, newModel);
                  }
                }}
                disabled={isUploading || isCheckingMatch}
              >
                {AI_MODEL_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Existing Book Detection & Unification Banner */}
            {isCheckingMatch ? (
              <div className="rounded-md border border-line-soft bg-surface-raised px-3 py-2 text-xs text-muted flex items-center gap-2">
                <svg className="animate-spin h-3.5 w-3.5 text-accent" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <span>Scanning Audiobookshelf for existing book matches...</span>
              </div>
            ) : matchResult?.matchFound && matchResult.candidate ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                    <span>📚 Existing book found in Audiobookshelf</span>
                    {matchResult.candidate.hasEbook && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-300 font-normal">
                        Contains eBook / PDF
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-emerald-400/80 font-mono font-medium">
                    {Math.round(matchResult.confidence * 100)}% match
                  </span>
                </div>
                <div className="text-foreground">
                  <p className="font-medium">
                    &ldquo;{matchResult.candidate.title}&rdquo;
                    {matchResult.candidate.author ? ` by ${matchResult.candidate.author}` : ''}
                  </p>
                  <p className="text-[11px] text-muted mt-0.5">
                    Target Folder: <span className="font-mono text-foreground/90 font-medium">{matchResult.candidate.folderName}</span>
                  </p>
                  {matchResult.reasoning && (
                    <p className="text-[11px] text-muted italic mt-0.5">&ldquo;{matchResult.reasoning}&rdquo;</p>
                  )}
                </div>
                <div className="pt-2 border-t border-emerald-500/20">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mergeIntoExisting}
                      onChange={(e) => setMergeIntoExisting(e.target.checked)}
                      disabled={isUploading}
                      className="mt-0.5 rounded border-emerald-500/40 text-emerald-600 focus:ring-emerald-500"
                    />
                    <div>
                      <span className="font-medium text-emerald-200">
                        Merge into existing Audiobookshelf book (Recommended)
                      </span>
                      <p className="text-[11px] text-muted">
                        {mergeIntoExisting
                          ? 'Audiobook will be placed directly into the existing book folder so Audiobookshelf unifies both into a single card with both "Listen" and "Read" capabilities.'
                          : 'A new standalone book card will be created.'}
                      </p>
                    </div>
                  </label>
                </div>
              </div>
            ) : null}

            {/* Library & Folder selectors */}
            {libraries.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">Target Library</label>
                  <select
                    className="w-full rounded-md border border-line-soft bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    value={libraryId}
                    onChange={(e) => handleLibraryChange(e.target.value)}
                    disabled={isUploading}
                  >
                    {libraries.map((lib) => (
                      <option key={lib.id} value={lib.id}>
                        {lib.name} ({lib.mediaType})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-foreground">Target Folder</label>
                  <select
                    className="w-full rounded-md border border-line-soft bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-accent"
                    value={folderId}
                    onChange={(e) => setFolderId(e.target.value)}
                    disabled={isUploading || folders.length === 0}
                  >
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.fullPath}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Include companion eBook (.epub) checkbox */}
            <div className="pt-2 border-t border-line-soft">
              <label className={`flex items-start gap-2.5 ${candidateHasEbook ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'} text-xs text-foreground`}>
                <input
                  type="checkbox"
                  checked={!candidateHasEbook && includeCompanion}
                  onChange={(e) => setIncludeCompanion(e.target.checked)}
                  disabled={isUploading || candidateHasEbook}
                  className="mt-0.5 rounded border-line-soft text-accent focus:ring-accent disabled:opacity-50"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      Include companion eBook (.epub)
                    </span>
                    {candidateHasEbook && (
                      <span className="px-2 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-400 font-semibold border border-emerald-500/30">
                        ✓ Existing eBook already in Audiobookshelf (will not overwrite)
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted mt-0.5">
                    {candidateHasEbook
                      ? 'The matched book in Audiobookshelf already has an eBook/PDF. OpenReader will attach the new audiobook while keeping your existing eBook intact.'
                      : 'Compiles a reflowable publication-grade .epub with digital table of contents and cover so Audiobookshelf pairs the text with the audio for seamless read & listen.'}
                  </p>
                </div>
              </label>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-4 border-t border-line-soft">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleUpload}
            disabled={isUploading || !config?.configured || !title.trim()}
          >
            {isUploading ? 'Exporting...' : 'Send to Audiobookshelf'}
          </Button>
        </div>
      </div>
    </ModalFrame>
  );
}
