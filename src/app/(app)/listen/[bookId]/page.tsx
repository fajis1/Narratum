"use client";

import { useState, useEffect, useRef, use, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HTMLViewer } from "@/components/views/HTMLViewer";
import { parseHtmlBlocks } from "@/lib/client/html/blocks";
import { BookPronunciationInspectorModal } from "@/components/doclist/BookPronunciationInspectorModal";
import { GeminiDramaSpeakerReview } from "@/components/audiobooks/GeminiDramaSpeakerReview";
import { MultiVoiceReviewStudio } from "@/components/audiobooks/MultiVoiceReviewStudio";
import { MobileReviewPlayer } from "@/components/audiobooks/MobileReviewPlayer";
import { BatchRefineReviewModal } from "@/components/audiobooks/BatchRefineReviewModal";
import { PronunciationIssuesModal } from "@/components/audiobooks/PronunciationIssuesModal";
import { AudiobookshelfModal } from "@/components/audiobooks/AudiobookshelfModal";
import { ChapterErrorLogModal } from "@/components/audiobooks/ChapterErrorLogModal";
import { BASE_BOOKS, PRESET_MODELS } from "@/components/constants";
import { toast } from "react-hot-toast";
import { Button, ModalTitle, ModalFrame } from "@/components/ui";
import { SmartAudioSettings } from "@/components/SmartAudioSettings";
import { DRAMA_GEMINI_TTS_WORKER_MODE, estimateSpeakerSegmentAtTime, parseVoiceTaggedText, renderVoiceSegments } from "@/lib/shared/multi-voice";
import type { SmartAudioProfile } from '@/types/client';
import type { SmartAudioCharacterMap, SmartAudioReviewFlag } from "@/types/document-settings";
import { AUDIOBOOK_WAITING_FOR_GPU_PHASE } from "@/lib/shared/audiobook-runtime-phase";
import {
  BATCH_REFINE_RECORDING_OPTION_HELP,
  type BatchRefineRecordingMode,
} from "@/lib/shared/batch-refine-review";


import { chapterNeedsReview, filterAndSortChapters } from '@/components/audiobooks/review/review-chapters';
import { ReviewHeader } from '@/components/audiobooks/review/ReviewHeader';
import { ReviewBookMenu } from '@/components/audiobooks/review/ReviewBookMenu';
import { ReviewChapterMenu } from '@/components/audiobooks/review/ReviewChapterMenu';
import { ReviewWorkspaceToolbar } from '@/components/audiobooks/review/ReviewWorkspaceToolbar';
import { ReviewMobilePaneSelector, type ReviewPane } from '@/components/audiobooks/review/ReviewPaneSelector';
import { ReviewAiCleanDialog } from '@/components/audiobooks/review/ReviewAiCleanDialog';
import { ReviewUnsavedChangesDialog } from '@/components/audiobooks/review/ReviewUnsavedChangesDialog';
import { ReviewIssuesPanel } from '@/components/audiobooks/review/ReviewIssuesPanel';
import { ReviewJobStatus } from '@/components/audiobooks/review/ReviewJobStatus';
import { ReviewChapterList } from '@/components/audiobooks/review/ReviewChapterList';

interface Chapter {
  index: number;
  title: string;
  duration?: number;
  format: string;
  isEmptyText?: boolean;
  hasAudio?: boolean;
  hasRejected?: boolean;
  hasFailure?: boolean;
  needsReview?: boolean;
  status?: string;
}

export default function ListenPage({ params }: { params: Promise<{ bookId: string }> }) {
  const unwrappedParams = use(params);
  const bookId = unwrappedParams.bookId;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentChapterPosition, setCurrentChapterPosition] = useState(0);
  const [chapterFilter, setChapterFilter] = useState<'all' | 'needs_review'>('all');
  const [chapterSort, setChapterSort] = useState<'default' | 'review_first'>('default');
  const [chapterSearch, setChapterSearch] = useState('');
  
  const [mobilePane, setMobilePane] = useState<ReviewPane>('edit');
  const [showAiClean, setShowAiClean] = useState(false);
  const [showForceRecord, setShowForceRecord] = useState(false);
  const [pendingChapterIndex, setPendingChapterIndex] = useState<number | null>(null);
  const [hasSpeakerChanges, setHasSpeakerChanges] = useState(false);
  const savedChapterText = useRef('');
  const editorSnapshot = useRef({ index: undefined as number | undefined, text: '', dirty: false });
  const textRequestSequence = useRef(0);
  const filterSelectionAttempt = useRef('');
  const [showLeftPane, setShowLeftPane] = useState(true);
  const [showMiddlePane, setShowMiddlePane] = useState(true);
  const [showRightPane, setShowRightPane] = useState(true);

  const [chapterText, setChapterText] = useState("");
  const [originalText, setOriginalText] = useState("");
  const [hasEditedText, setHasEditedText] = useState(false);
  const [showBatchRefineModal, setShowBatchRefineModal] = useState(false);
  const [showBatchRefineReview, setShowBatchRefineReview] = useState(false);
  const [showPronunciationIssues, setShowPronunciationIssues] = useState(false);
  const [showAudiobookshelfModal, setShowAudiobookshelfModal] = useState(false);
  const [errorLogModalChapter, setErrorLogModalChapter] = useState<{ index: number | null; title?: string | null } | null>(null);
  const [batchRefineRunId, setBatchRefineRunId] = useState<string | null>(null);
  const [batchRefineRule, setBatchRefineRule] = useState('');
  const [batchRefineModel, setBatchRefineModel] = useState('gemini-2.5-flash');
  const [batchRefineKeys, setBatchRefineKeys] = useState({ primary: '', backup: '' });
  const [batchRefineProfileName, setBatchRefineProfileName] = useState('');
  const [batchRefineProfileCategory, setBatchRefineProfileCategory] = useState('standard');
  const [batchRefineRecordingMode, setBatchRefineRecordingMode] = useState<BatchRefineRecordingMode>('review');
  const [batchRefineHoldHighPriority, setBatchRefineHoldHighPriority] = useState(true);
  const [batchRefineOptionHelp, setBatchRefineOptionHelp] = useState<BatchRefineRecordingMode | null>(null);
  const [isBatchRefining, setIsBatchRefining] = useState(false);
  const [activeJob, setActiveJob] = useState<{ id: string; status: string; progress?: number; phase?: string; settingsJson?: string | Record<string, unknown> } | null>(null);
  const [isTextLoading, setIsTextLoading] = useState(false);
  const [audioRevision, setAudioRevision] = useState(0);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isRebuildingAll, setIsRebuildingAll] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isPronunciationModalOpen, setIsPronunciationModalOpen] = useState(false);
  const [isQuickAbbrevModalOpen, setIsQuickAbbrevModalOpen] = useState(false);
  const [newAbbrevKey, setNewAbbrevKey] = useState('');
  const [newAbbrevVal, setNewAbbrevVal] = useState('');
  const [selectedText, setSelectedText] = useState("");
  
  const [showGeminiFullText, setShowGeminiFullText] = useState(false);
  const [showMultiVoiceStudio, setShowMultiVoiceStudio] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);
  const [smartAudioProfiles, setSmartAudioProfiles] = useState<SmartAudioProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [cleanTarget, setCleanTarget] = useState<'original' | 'edited'>('edited');
  const [isFixingAll, setIsFixingAll] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [voiceCharacters, setVoiceCharacters] = useState<Record<string, string[]>>({});
  const [castCharacters, setCastCharacters] = useState<Array<{ name: string; voiceId: string }>>([]);
  const [playingSpeakerSegment, setPlayingSpeakerSegment] = useState<number | null>(null);
  const [speakerTextDrafts, setSpeakerTextDrafts] = useState<Record<number, string>>({});
  const [activeSpeakerSegment, setActiveSpeakerSegment] = useState<number | null>(null);
  const [reviewFlags, setReviewFlags] = useState<SmartAudioReviewFlag[]>([]);
  const [reviewFlagsError, setReviewFlagsError] = useState<string | null>(null);
  const [retryingReviewFlagId, setRetryingReviewFlagId] = useState<string | null>(null);
  const currentChapter = chapters[currentChapterPosition];
  const selectedChapterIndex = currentChapter?.index;

  const isMultiVoice = chapterText.includes('<voice');
  const selectedSmartAudioProfile = smartAudioProfiles.find((profile) => profile.id === selectedProfileId)
    || smartAudioProfiles[0];
  const isGeminiDrama = selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE;
  const isDramaReview = isMultiVoice || isGeminiDrama;
  const isWaitingForGpu = activeJob?.phase === AUDIOBOOK_WAITING_FOR_GPU_PHASE;

  useEffect(() => {
    if (searchParams.get('reviewPronunciation') !== 'true') return;
    setShowPronunciationIssues(true);
    const next = new URLSearchParams(searchParams.toString());
    next.delete('reviewPronunciation');
    router.replace(next.size ? `/listen/${encodeURIComponent(bookId)}?${next}` : `/listen/${encodeURIComponent(bookId)}`);
  }, [bookId, router, searchParams]);

  useEffect(() => {
    const filterParam = searchParams.get('filter') || searchParams.get('tab');
    const needsReviewParam = searchParams.get('needsReview');
    if (filterParam === 'review' || filterParam === 'needs_review' || needsReviewParam === 'true') {
      setChapterFilter('needs_review');
    }
  }, [searchParams]);

  const isChapterNeedingReview = useCallback((chapter: Chapter) => chapterNeedsReview(chapter, reviewFlags), [reviewFlags]);
  const reviewChaptersCount = useMemo(() => chapters.filter(isChapterNeedingReview).length, [chapters, isChapterNeedingReview]);
  const visibleChapters = useMemo(() => filterAndSortChapters(chapters, chapterFilter, chapterSort, chapterSearch, reviewFlags), [chapters, chapterFilter, chapterSort, chapterSearch, reviewFlags]);

  const requestChapterSelection = useCallback((chapterIndex: number) => {
    if (chapterIndex === editorSnapshot.current.index) return;
    if (!chapters.some(chapter => chapter.index === chapterIndex)) return;
    if (editorSnapshot.current.dirty) {
      setPendingChapterIndex(chapterIndex);
      return;
    }
    setCurrentChapterPosition(chapters.findIndex(chapter => chapter.index === chapterIndex));
  }, [chapters]);

  useEffect(() => {
    if (chapterFilter !== 'needs_review' || !visibleChapters.length) {
      filterSelectionAttempt.current = '';
      return;
    }
    if (visibleChapters.some(c => c.index === selectedChapterIndex)) return;
    // Attempt once per filtered selection; Stay Here must not reopen the dialog on polling.
    const attempt = `${selectedChapterIndex}:${visibleChapters[0].index}:${chapterSearch}`;
    if (filterSelectionAttempt.current === attempt) return;
    filterSelectionAttempt.current = attempt;
    requestChapterSelection(visibleChapters[0].index);
  }, [chapterFilter, visibleChapters, selectedChapterIndex, chapterSearch, requestChapterSelection]);

  const currentVisibleIndex = visibleChapters.findIndex(c => c.index === selectedChapterIndex);
  const canGoPrev = currentVisibleIndex > 0;
  const canGoNext = currentVisibleIndex >= 0 && currentVisibleIndex < visibleChapters.length - 1;
  const handlePrevChapter = () => {
    if (canGoPrev) requestChapterSelection(visibleChapters[currentVisibleIndex - 1].index);
  };
  const handleNextChapter = () => {
    if (canGoNext) requestChapterSelection(visibleChapters[currentVisibleIndex + 1].index);
  };
  const activeJobSettings = useMemo(() => {
    if (!activeJob?.settingsJson) return {} as Record<string, unknown>;
    if (typeof activeJob.settingsJson === 'string') {
      try {
        return JSON.parse(activeJob.settingsJson) as Record<string, unknown>;
      } catch {
        return {} as Record<string, unknown>;
      }
    }
    return activeJob.settingsJson as Record<string, unknown>;
  }, [activeJob]);
  const activeBatchRefineRunId = typeof activeJobSettings.batchRefineRunId === 'string'
    ? activeJobSettings.batchRefineRunId
    : batchRefineRunId;
  const speakerSegments = useMemo(() => {
    if (!isMultiVoice) return [];
    try {
      return parseVoiceTaggedText(chapterText, { includeOmitted: true }).map((segment, index) => ({
        id: `${index}-${segment.voiceId}`,
        voiceId: segment.voiceId,
        speaker: voiceCharacters[segment.voiceId]?.join(', ') || segment.voiceId,
        text: segment.text,
        omitted: segment.omitted === true,
      }));
    } catch {
      return [];
    }
  }, [chapterText, isMultiVoice, voiceCharacters]);

  const speakerDraftSnapshot = useRef('');
  speakerDraftSnapshot.current = JSON.stringify(speakerTextDrafts);
  const hasSpeakerDrafts = speakerSegments.some((segment, index) =>
    speakerTextDrafts[index] !== undefined && speakerTextDrafts[index] !== segment.text);
  const hasSpeakerEdits = hasSpeakerChanges || hasSpeakerDrafts;
  const isDirty = hasEditedText || hasSpeakerEdits;
  editorSnapshot.current = { index: selectedChapterIndex, text: chapterText, dirty: isDirty };

  const textWithSpeakerDrafts = () => {
    if (!hasSpeakerDrafts) return chapterText;
    const parsed = parseVoiceTaggedText(chapterText, { includeOmitted: true });
    return renderVoiceSegments(parsed.map((segment, index) => ({
      ...segment, text: speakerTextDrafts[index] ?? segment.text,
    })));
  };

  useEffect(() => {
    if (!isDirty) return;
    const protectReload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectReload);
    return () => window.removeEventListener('beforeunload', protectReload);
  }, [isDirty]);

  useEffect(() => {
    setActiveSpeakerSegment(null);
  }, [currentChapterPosition]);

  useEffect(() => {
    if (activeSpeakerSegment === null) return;
    document.getElementById(`drama-speaker-row-${activeSpeakerSegment}`)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeSpeakerSegment]);

  useEffect(() => {
    const handleOpenSettings = () => setIsSettingsModalOpen(true);
    window.addEventListener('open-smart-audio-settings', handleOpenSettings);
    return () => {
      window.removeEventListener('open-smart-audio-settings', handleOpenSettings);
    };
  }, []);

  const blocks = useMemo(() => {
    // Show original text in middle pane, fallback to chapterText if original isn't ready
    const textToRender = originalText || chapterText;
    if (!textToRender) return [];
    return parseHtmlBlocks(textToRender, true); // true for isTxt
  }, [chapterText, originalText]);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/audiobook/status?bookId=${bookId}`);
      const data = await res.json();
      if (data.chapters && data.chapters.length > 0) {
        const selected = editorSnapshot.current.index;
        if (editorSnapshot.current.dirty && !data.chapters.some((chapter: Chapter) => chapter.index === selected)) return;
        const position = data.chapters.findIndex((chapter: Chapter) => chapter.index === selected);
        setCurrentChapterPosition(position >= 0 ? position : 0);
        setChapters((prev) => {
          // Only update if something changed to avoid unnecessary re-renders
          if (JSON.stringify(prev) !== JSON.stringify(data.chapters)) {
            return data.chapters;
          }
          return prev;
        });
      } else if (!editorSnapshot.current.dirty) {
        setChapters([]);
      }
    } catch (err) {
      console.error("Failed to fetch audiobook status", err);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    fetchStatus();
    
    const fetchProfiles = async () => {
      try {
        const res = await fetch('/api/tts-settings');
        const data = await res.json();
        if (data.smartAudioProfiles) {
          setSmartAudioProfiles(data.smartAudioProfiles);
          setSelectedProfileId(data.selectedSmartAudioProfileId || data.smartAudioProfiles[0]?.id || '');
        }
      } catch (err) {
        console.error("Failed to fetch profiles", err);
      }
    };
    fetchProfiles();

    const checkJob = async () => {
      try {
        const res = await fetch('/api/audiobooks/queue');
        if (res.ok) {
          const data = await res.json();
          const job = data.jobs?.find((candidate: { documentId?: string; status?: string }) => (
            candidate.documentId === bookId
            && ['queued', 'running', 'waiting_for_pdf', 'pausing'].includes(candidate.status || '')
          ));
          if (job) {
            setActiveJob(job);
            if (job.status === 'running' || job.status === 'queued') {
               setIsBatchRefining(true);
            } else {
               setIsBatchRefining(false);
            }
          } else {
            setActiveJob(null);
            setIsBatchRefining(false);
          }
        }
      } catch {}
    };
    
    checkJob();

    // Poll every 5 seconds to get live updates for background tasks
    const interval = setInterval(() => {
       fetchStatus();
       checkJob();
    }, 5000);
    return () => clearInterval(interval);
  }, [bookId, fetchStatus]);

  const fetchReviewFlags = useCallback(async () => {
    try {
      const response = await fetch(`/api/audiobook/review-flags?documentId=${encodeURIComponent(bookId)}`, {
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({})) as { flags?: SmartAudioReviewFlag[]; error?: string };
      if (!response.ok) throw new Error(body.error || 'Failed to load review flags.');
      setReviewFlags(Array.isArray(body.flags) ? body.flags : []);
      setReviewFlagsError(null);
    } catch (error) {
      setReviewFlagsError(error instanceof Error ? error.message : 'Failed to load review flags.');
    }
  }, [bookId]);

  useEffect(() => {
    void fetchReviewFlags();
  }, [fetchReviewFlags]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/documents/${encodeURIComponent(bookId)}/settings`, { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body) => {
        if (cancelled) return;
        const map = body?.settings?.smartAudioCharacters as SmartAudioCharacterMap | undefined;
        if (!map?.entries) {
          setVoiceCharacters({});
          setCastCharacters([]);
          return;
        }
        const labels: Record<string, string[]> = {};
        const choices: Array<{ name: string; voiceId: string }> = [];
        for (const entry of Object.values(map.entries)) {
          const primary = entry.aliasFor ? map.entries[entry.aliasFor] : entry;
          if (!primary?.voiceId) continue;
          labels[primary.voiceId] = Array.from(new Set([
            ...(labels[primary.voiceId] || []),
            entry.name,
          ]));
          if (!entry.aliasFor) choices.push({ name: entry.name, voiceId: primary.voiceId });
        }
        setVoiceCharacters(labels);
        setCastCharacters(choices);
      })
      .catch(() => {
        if (!cancelled) {
          setVoiceCharacters({});
          setCastCharacters([]);
        }
      });
    return () => { cancelled = true; };
  }, [bookId]);

  const fetchChapterText = useCallback(async (index: number, isBackgroundPoll = false) => {
    const sequence = ++textRequestSequence.current;
    if (!isBackgroundPoll) setIsTextLoading(true);
    const mayApply = () => sequence === textRequestSequence.current
      && editorSnapshot.current.index === index && !editorSnapshot.current.dirty;
    try {
      const [resText, resOrig] = await Promise.all([
        fetch(`/api/audiobook/text?bookId=${bookId}&chapterIndex=${index}&t=${Date.now()}`, { cache: 'no-store' }),
        fetch(`/api/audiobook/text?bookId=${bookId}&chapterIndex=${index}&type=original&t=${Date.now()}`, { cache: 'no-store' }),
      ]);
      const [text, original] = await Promise.all([
        resText.ok ? resText.text() : Promise.resolve(null),
        resOrig.ok ? resOrig.text() : Promise.resolve(null),
      ]);
      if (!mayApply()) return;
      if (original !== null || !isBackgroundPoll) setOriginalText(original ?? '');
      if (text !== null || !isBackgroundPoll) {
        savedChapterText.current = text ?? 'No text available for this chapter.';
        setChapterText(savedChapterText.current);
      }
    } catch (err) {
      console.error(err);
      if (!isBackgroundPoll && mayApply()) {
        setChapterText('Failed to load text.');
        setOriginalText('');
      }
    } finally {
      if (sequence === textRequestSequence.current) setIsTextLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    if (selectedChapterIndex !== undefined) {
      // Only guarded chapter selection reaches this point.
      setHasEditedText(false);
      setHasSpeakerChanges(false);
      setSpeakerTextDrafts({});
      setChapterText('');
      setOriginalText('');
      savedChapterText.current = '';
      fetchChapterText(selectedChapterIndex);
    }
  }, [selectedChapterIndex, fetchChapterText]);

  // Poll for text updates if we haven't manually edited
  useEffect(() => {
    if (isDirty || selectedChapterIndex === undefined) return;
    const interval = setInterval(() => {
      fetchChapterText(selectedChapterIndex, true);
    }, 5000);
    return () => clearInterval(interval);
  }, [isDirty, selectedChapterIndex, fetchChapterText]);

  const handleFixAbbreviations = () => {
    let pt = chapterText;
    const profile = smartAudioProfiles.find(p => p.id === selectedProfileId) || smartAudioProfiles[0];
    
    // Combine base books and custom profile books
    const booksMap: Record<string, string> = {};
    BASE_BOOKS.forEach(b => booksMap[b.key] = b.value);
    if (profile?.books) {
      Object.entries(profile.books).forEach(([k, v]) => booksMap[k] = v as string);
    }
    
    // 1. Expand books
    Object.entries(booksMap).forEach(([short, full]) => {
      const escapedShort = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedShort}\\.?\\s+(\\d+):(\\d+)(?:[-–](\\d+))?`, 'g');
      pt = pt.replace(regex, (match, chap, vStart, vEnd) => {
        if (vEnd) return `${full} chapter ${chap} verse ${vStart} through ${vEnd}`;
        return `${full} chapter ${chap} verse ${vStart}`;
      });
    });

    // 2. vv. and v.
    pt = pt.replace(/\bvv\.\s*(\d+)/g, 'verses $1');
    pt = pt.replace(/\bv\.\s*(\d+)/g, 'verse $1');

    // 3. User abbreviations
    if (profile?.abbreviations) {
      const keys = Object.keys(profile.abbreviations).sort((a, b) => b.length - a.length);
      keys.forEach(key => {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?<!\\w)${escapedKey}(?!\\w)`, 'g');
        pt = pt.replace(regex, profile.abbreviations[key]);
      });
    }

    setChapterText(pt);
    editorSnapshot.current.dirty = true;
    setHasEditedText(true);
    toast.success("Abbreviations expanded successfully!");
  };

  const handleRegenerate = async (textOverride?: string) => {
    const textToRecord = textOverride ?? textWithSpeakerDrafts();
    if (!textToRecord || !currentChapter) return false;
    const submittedIndex = currentChapter.index;
    const submittedEditor = chapterText;
    const submittedDrafts = JSON.stringify(speakerTextDrafts);
    setIsRegenerating(true);
    try {
      const res = await fetch(`/api/audiobook/chapter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId,
          documentId: bookId,
          chapterIndex: currentChapter.index,
          chapterTitle: currentChapter.title,
          text: textToRecord,
          useSmartAudio: isGeminiDrama,
          ...(isGeminiDrama ? { settings: { smartAudioProfileId: selectedProfileId } } : {}),
          format: currentChapter.format,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; detail?: string; message?: string };
        const msg = body.error || body.detail || body.message || `Failed to regenerate audio (${res.status})`;
        throw new Error(msg);
      }
      
      setAudioRevision(value => value + 1);
      toast.success("Saved chapter text and queued re-recording");
      if (editorSnapshot.current.index === submittedIndex && (editorSnapshot.current.text === submittedEditor || (textOverride !== undefined && editorSnapshot.current.text === textOverride))
        && speakerDraftSnapshot.current === submittedDrafts) {
        savedChapterText.current = textToRecord;
        editorSnapshot.current = { index: submittedIndex, text: textToRecord, dirty: false };
        setChapterText(textToRecord);
        setHasEditedText(false);
        setHasSpeakerChanges(false);
        setSpeakerTextDrafts({});
        return true;
      }
      // A newer edit was made while saving; keep it and do not continue navigation.
      return false;
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : "Failed to trigger regeneration");
      return false;
    } finally {
      setIsRegenerating(false);
    }
  };

  const resolveReviewFlag = async (flagId: string) => {
    try {
      const response = await fetch('/api/audiobook/review-flags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: bookId, flagId }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Failed to resolve the review flag.');
      await fetchReviewFlags();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to resolve the review flag.');
    }
  };

  const retryReviewFlag = async (flag: SmartAudioReviewFlag) => {
    const chapter = chapters.find((candidate) => candidate.index === flag.chapterIndex);
    if (!chapter) {
      toast.error('The chapter for this review flag is no longer available.');
      return;
    }
    setRetryingReviewFlagId(flag.id);
    try {
      const textResponse = await fetch(`/api/audiobook/text?bookId=${encodeURIComponent(bookId)}&chapterIndex=${chapter.index}&t=${Date.now()}`, {
        cache: 'no-store',
      });
      if (!textResponse.ok) throw new Error('Failed to load the saved chapter text.');
      const text = await textResponse.text();
      const response = await fetch('/api/audiobook/chapter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId,
          documentId: bookId,
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          text,
          useSmartAudio: isGeminiDrama,
          ...(isGeminiDrama ? { settings: { smartAudioProfileId: selectedProfileId } } : {}),
          format: chapter.format,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Failed to queue chapter recovery.');
      requestChapterSelection(chapter.index);
      toast.success(`Recovery queued for chapter ${chapter.index + 1}.`);
      await fetchReviewFlags();
      await fetchStatus();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to retry the chapter.');
    } finally {
      setRetryingReviewFlagId(null);
    }
  };

  const updateSpeakerAssignment = (segmentIndex: number, characterName: string) => {
    const choice = castCharacters.find((character) => character.name === characterName);
    if (!choice) return;
    try {
      const parsed = parseVoiceTaggedText(chapterText, { includeOmitted: true });
      if (!parsed[segmentIndex]) return;
      parsed[segmentIndex] = {
        ...parsed[segmentIndex],
        speaker: characterName,
        voiceId: choice.voiceId,
      };
      setChapterText(renderVoiceSegments(parsed));
      editorSnapshot.current.dirty = true;
      setHasSpeakerChanges(true);
    } catch {
      toast.error('This chunk has invalid speaker markup and cannot be reassigned safely.');
    }
  };

  const rerecordSpeakerSegment = (segmentIndex: number) => {
    try {
      const parsed = parseVoiceTaggedText(chapterText, { includeOmitted: true });
      const nextText = speakerTextDrafts[segmentIndex]?.trim();
      if (!parsed[segmentIndex] || !nextText) return;
      parsed[segmentIndex] = { ...parsed[segmentIndex], text: nextText };
      const updatedChapterText = renderVoiceSegments(parsed);
      setChapterText(updatedChapterText);
      editorSnapshot.current.dirty = true;
      setHasSpeakerChanges(true);
      void handleRegenerate(updatedChapterText);
    } catch {
      toast.error('This chunk has invalid speaker markup and cannot be re-recorded safely.');
    }
  };

  const restoreOmittedSegment = (segmentIndex: number) => {
    try {
      const parsed = parseVoiceTaggedText(chapterText, { includeOmitted: true });
      if (!parsed[segmentIndex]) return;
      parsed[segmentIndex] = { ...parsed[segmentIndex], omitted: false };
      setChapterText(renderVoiceSegments(parsed));
      editorSnapshot.current.dirty = true;
      setHasSpeakerChanges(true);
    } catch {
      toast.error('This removed segment could not be restored safely.');
    }
  };

  const previewSpeakerSegment = async (segmentIndex: number) => {
    const segment = speakerSegments[segmentIndex];
    if (!segment || segment.omitted) return;
    setPlayingSpeakerSegment(segmentIndex);
    try {
      const response = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: segment.text.slice(0, 500), voice: segment.voiceId }),
      });
      if (!response.ok) throw new Error('Speaker preview failed.');
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      const finish = () => {
        URL.revokeObjectURL(url);
        setPlayingSpeakerSegment(null);
        if (previewAudioRef.current === audio) previewAudioRef.current = null;
      };
      audio.onended = finish;
      audio.onerror = finish;
      await audio.play();
    } catch (error) {
      setPlayingSpeakerSegment(null);
      toast.error(error instanceof Error ? error.message : 'Speaker preview failed.');
    }
  };

  const activeSpeakerAtPlaybackTime = (currentTime: number, duration: number) => {
    const audible = speakerSegments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => !segment.omitted);
    const audibleIndex = estimateSpeakerSegmentAtTime(
      audible.map(({ segment }) => segment.text),
      currentTime,
      duration,
    );
    return audibleIndex === null ? null : audible[audibleIndex]?.index ?? null;
  };

  const handleRebuildAllModified = async () => {
    setIsRebuildingAll(true);
    try {
      const res = await fetch('/api/audiobooks/batch-regenerate', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId: bookId, dryRun: true }) 
      });
      if (res.ok) {
        const data = await res.json();
        if (data.needsRegeneration && data.needsRegeneration.length > 0) {
           const chunkCount = data.needsRegeneration[0].modifiedChunks;
           const startRes = await fetch('/api/audiobooks/batch-regenerate', { 
             method: 'POST', 
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ bookId: bookId }) 
           });
           if (startRes.ok) {
             toast.success(`Background rebuild started for ${chunkCount} modified chunk${chunkCount === 1 ? '' : 's'}!`);
           } else {
             const err = await startRes.json().catch(() => ({}));
             toast.error(err.error || 'Failed to start rebuild');
           }
        } else {
           toast.success('No modified chunks found! Everything is up to date.');
        }
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to scan');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error scanning books');
    } finally {
      setIsRebuildingAll(false);
    }
  };

  const handleOpenBatchRefine = async () => {
    setShowBatchRefineModal(true);
    try {
      const query = new URLSearchParams({ bookId });
      if (selectedProfileId) query.set('smartAudioProfileId', selectedProfileId);
      const res = await fetch(`/api/audiobooks/batch-refine?${query.toString()}`);
      if (res.ok) {
        const data = await res.json();
        if (data.defaultModel) setBatchRefineModel(data.defaultModel);
        setBatchRefineKeys({ primary: data.primaryKeyMasked || 'Not Set', backup: data.backupKeyMasked || 'Not Set' });
        setBatchRefineProfileName(data.selectedProfileName || 'Standard audiobook');
        setBatchRefineProfileCategory(data.profileCategory || 'standard');
      }
    } catch {}
  };

  const handleBatchRefine = async () => {
    if (!batchRefineRule.trim()) return toast.error("Please enter a rule.");
    setIsBatchRefining(true);
    try {
      const res = await fetch('/api/audiobooks/batch-refine', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           bookId,
           rule: batchRefineRule.trim(),
           aiModel: batchRefineModel,
           smartAudioProfileId: selectedProfileId,
           recordingMode: batchRefineRecordingMode,
           holdHighPriority: batchRefineHoldHighPriority,
         })
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        setBatchRefineRunId(typeof body.runId === 'string' ? body.runId : null);
        setActiveJob({
          id: body.jobId || 'temp-id',
          status: 'queued',
          progress: 0,
          settingsJson: {
            jobType: 'batch-refine',
            batchRefineRunId: body.runId,
            recordingMode: batchRefineRecordingMode,
          }
        });
        setShowBatchRefineModal(false);
        toast.success(batchRefineRecordingMode === 'review'
          ? 'Batch Refine started. Changed chapters will wait for your review.'
          : 'Batch Refine started. Eligible changes will record as they are made.');
      } else {
         const err = await res.json().catch(() => ({}));
         toast.error(err.error || 'Failed to start batch refine');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error starting batch refine');
    } finally {
      setIsBatchRefining(false);
    }
  };

  const handleForceRebuildAll = async () => {
    setShowForceRecord(false);
    setIsRebuildingAll(true);
    try {
      const startRes = await fetch('/api/audiobooks/batch-regenerate', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ bookId: bookId, forceAll: true })
      });
      if (startRes.ok) {
         toast.success('Background force rebuild started for all chunks!');
      } else {
         const err = await startRes.json().catch(() => ({}));
         toast.error(err.error || 'Failed to start force rebuild');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error starting force rebuild');
    } finally {
      setIsRebuildingAll(false);
    }
  };

  const handleFixAllAbbreviations = async () => {
    setIsFixingAll(true);
    try {
      const res = await fetch('/api/audiobooks/fix-abbreviations-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, smartAudioProfileId: selectedProfileId })
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Fixed abbreviations in ${data.modifiedCount} chunks!`);
        if (data.modifiedCount > 0) {
          // Refresh current chunk just in case it was modified
          if (selectedChapterIndex !== undefined) {
            fetchChapterText(selectedChapterIndex);
          }
        }
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to fix abbreviations');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error fixing abbreviations');
    } finally {
      setIsFixingAll(false);
    }
  };

  const handleAiClean = () => {
    const textToSend = cleanTarget === 'edited' ? textWithSpeakerDrafts() : (originalText || chapterText);
    if (!textToSend) return;
    setIsRegenerating(true);
    fetch(`/api/audiobook/chapter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookId,
        documentId: bookId,
        chapterIndex: currentChapter.index,
        chapterTitle: currentChapter.title,
        text: textToSend,
        useSmartAudio: true,
        settings: { smartAudioProfileId: selectedProfileId, scholarAutoScan: true },
        format: currentChapter.format,
      }),
              }).then(async res => {
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error("API error text:", txt);
      throw new Error(`Failed to queue AI cleanup: ${res.status} ${txt.substring(0, 100)}`);
    }
    toast.success("Queued for AI Cleanup! (Waiting for worker...)");
        setShowAiClean(false);
              }).catch(err => {
    console.error(err);
    toast.error(err.message || "Failed to trigger AI cleanup");
              }).finally(() => setIsRegenerating(false));
  };

  const revertEdits = () => {
    setChapterText(savedChapterText.current);
    setHasEditedText(false);
    setHasSpeakerChanges(false);
    setSpeakerTextDrafts({});
    editorSnapshot.current.dirty = false;
  };
  const continuePendingSelection = () => {
    if (pendingChapterIndex === null) return;
    const target = pendingChapterIndex;
    setPendingChapterIndex(null);
    requestChapterSelection(target);
  };
  const discardAndNavigate = () => {
    revertEdits();
    continuePendingSelection();
  };
  const saveAndNavigate = async () => {
    if (await handleRegenerate()) continuePendingSelection();
  };
  const cancelActiveJob = async () => {
    if (!activeJob) return;
    try {
      const response = await fetch(`/api/audiobooks/queue?id=${activeJob.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to cancel background job.');
      setActiveJob(null);
      setIsBatchRefining(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to cancel background job.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface text-foreground">
        <div>Loading...</div>
      </div>
    );
  }

  if (chapters.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-surface text-foreground">
        <h1 className="text-2xl font-bold mb-4">No Audiobook Available</h1>
        <button className="mb-3 rounded border border-line-soft px-4 py-2" onClick={() => setShowPronunciationIssues(true)}>Scan Pronunciation Issues</button>
        <PronunciationIssuesModal open={showPronunciationIssues} onClose={() => setShowPronunciationIssues(false)} bookId={bookId} profileId={selectedProfileId} onRecordingQueued={() => void fetchStatus()} />
        <button className="px-4 py-2 bg-accent rounded" onClick={() => router.push("/app")}>Return to Dashboard</button>
      </div>
    );
  }

  if (!currentChapter) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface text-foreground">
        <div>Loading chapter...</div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-surface" data-testid="audiobook-review">
      <ReviewHeader title={currentChapter.title}
        position={`Chunk ${currentChapter.index + 1} · ${chapterFilter === 'needs_review' ? `Flagged ${currentVisibleIndex >= 0 ? currentVisibleIndex + 1 : '—'} of ${visibleChapters.length}` : `Item ${currentChapterPosition + 1} of ${chapters.length}`}`}
        needsReview={isChapterNeedingReview(currentChapter)} dirty={isDirty} recording={isRegenerating}
        processing={isTextLoading} filtered={chapterFilter === 'needs_review'}
        canPrevious={canGoPrev} canNext={canGoNext} onPrevious={handlePrevChapter} onNext={handleNextChapter}
        bookTools={<ReviewBookMenu onScan={() => setShowPronunciationIssues(true)}
          onReviewChanges={() => setShowBatchRefineReview(true)} onFixAll={() => void handleFixAllAbbreviations()}
          onBatchRefine={() => void handleOpenBatchRefine()} onRecordModified={() => void handleRebuildAllModified()}
          onExport={() => setShowAudiobookshelfModal(true)} onForceRecord={() => setShowForceRecord(true)}
          fixing={isFixingAll} rebuilding={isRebuildingAll} empty={!chapters.length}
          showReviewChanges={!(activeJob && ['running', 'queued'].includes(activeJob.status) && activeJobSettings.jobType === 'batch-refine')} />}
      />
      {activeJob && ['running', 'queued', 'waiting_for_pdf', 'pausing'].includes(activeJob.status) && <ReviewJobStatus
        label={activeJobSettings.jobType === 'batch-refine' ? 'AI Batch Refine' : 'Generating audiobook'}
        progress={activeJob.progress || 0} waiting={isWaitingForGpu}
        reviewChanges={activeJobSettings.jobType === 'batch-refine'} onReview={() => setShowBatchRefineReview(true)}
        changelogUrl={`/api/audiobooks/batch-refine/changelog?bookId=${encodeURIComponent(bookId)}${activeBatchRefineRunId ? `&runId=${encodeURIComponent(activeBatchRefineRunId)}` : ''}`}
        onCancel={() => void cancelActiveJob()} />}
      <ReviewWorkspaceToolbar panes={{ chapters: showLeftPane, original: showMiddlePane, edit: showRightPane }}
        onToggle={pane => { if (pane === 'chapters') setShowLeftPane(v => !v); else if (pane === 'original') setShowMiddlePane(v => !v); else setShowRightPane(v => !v); }}
        drama={isMultiVoice && !isGeminiDrama} onDrama={() => setShowMultiVoiceStudio(true)} onMobileAudio={() => setShowMobilePlayer(true)}
        onClean={() => setShowAiClean(true)} dirty={isDirty} speakerDirty={hasSpeakerEdits && !hasEditedText && showLeftPane && currentVisibleIndex >= 0}
        busy={isRegenerating || isTextLoading} onSave={() => void handleRegenerate()}
        chapterTools={<ReviewChapterMenu onDictionary={() => setIsPronunciationModalOpen(true)}
          onAbbreviation={() => { setNewAbbrevKey(''); setNewAbbrevVal(''); setIsQuickAbbrevModalOpen(true); }}
          onFixAbbreviations={handleFixAbbreviations} onSettings={() => setIsSettingsModalOpen(true)}
          onErrorLog={() => setErrorLogModalChapter({ index: currentChapter.index, title: currentChapter.title })}
          onDrama={isMultiVoice && !isGeminiDrama ? () => setShowMultiVoiceStudio(true) : undefined}
          onRecord={() => void handleRegenerate()} hasError={Boolean(currentChapter.status === 'error' || currentChapter.hasFailure || currentChapter.hasRejected || reviewFlags.some(f => f.chapterIndex === currentChapter.index))}
          dirty={isDirty} busy={isRegenerating || isTextLoading} />} />
      <ReviewMobilePaneSelector value={mobilePane} onChange={setMobilePane} />
      <ReviewIssuesPanel key={currentChapter.index} chapterIndex={currentChapter.index} flags={reviewFlags} error={reviewFlagsError}
        needsAttention={isChapterNeedingReview(currentChapter)} onChapterDetails={() => setErrorLogModalChapter({ index: currentChapter.index, title: currentChapter.title })}
        chapterExists={index => chapters.some(chapter => chapter.index === index)} retryingId={retryingReviewFlagId}
        onRetry={flag => void retryReviewFlag(flag)} onResolve={id => void resolveReviewFlag(id)}
        onDetails={flag => setErrorLogModalChapter({ index: flag.chapterIndex, title: chapters.find(c => c.index === flag.chapterIndex)?.title })}
        onAllLogs={() => setErrorLogModalChapter({ index: null })} onRefresh={() => void fetchReviewFlags()} />
      <div className="min-h-0 flex-1 flex flex-col md:flex-row overflow-hidden">
        {!showLeftPane && !showMiddlePane && !showRightPane && <p className="hidden p-4 text-sm text-soft md:block">Choose a pane using the Layout controls.</p>}
        <section aria-label="Chapters pane" className={`min-h-0 w-full flex-1 flex-col border-r border-line-soft bg-surface md:min-w-60 md:flex-none ${isDramaReview ? 'md:w-2/5' : 'md:w-1/4'} ${mobilePane === 'chapters' ? 'flex' : 'hidden'} ${showLeftPane ? 'md:flex' : 'md:hidden'}`}>
          <ReviewChapterList chapters={chapters} visible={visibleChapters} selectedIndex={currentChapter.index}
            reviewCount={reviewChaptersCount} filter={chapterFilter} onFilter={setChapterFilter}
            search={chapterSearch} onSearch={setChapterSearch} sort={chapterSort} onSort={setChapterSort}
            onSelect={requestChapterSelection} needsReview={isChapterNeedingReview}
            hasFlag={index => reviewFlags.some(flag => flag.chapterIndex === index)} selectedContent={<>
                    {isMultiVoice && !isGeminiDrama && (
                      <div className="ml-3 border-l border-accent-line py-1 pl-2" aria-label="Speaker segments for selected chapter">
                        {speakerSegments.length > 0 ? speakerSegments.map((segment, segmentIndex) => (
                          <div
                            key={segment.id}
                            id={`drama-speaker-row-${segmentIndex}`}
                            className={`mb-2 grid w-full grid-cols-1 gap-2 rounded border p-2 text-left 2xl:grid-cols-[2.5rem_minmax(0,0.7fr)_minmax(0,1.5fr)_auto] 2xl:items-start ${
                              segment.omitted
                                ? 'border-line bg-transparent outline outline-1 outline-dashed outline-line'
                                : activeSpeakerSegment === segmentIndex
                                ? 'border-accent bg-accent-wash shadow-sm'
                                : 'border-line-soft bg-surface-raised'
                            }`}
                          >
                            <div className={`text-xs font-bold ${activeSpeakerSegment === segmentIndex ? 'text-accent' : 'text-text-soft'}`}>
                              #{segmentIndex + 1}
                              {segment.omitted && <span className="mt-1 block text-[9px] uppercase text-text-soft">Removed from audio</span>}
                              {activeSpeakerSegment === segmentIndex && <span className="mt-1 block text-[9px] uppercase">Now playing</span>}
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold uppercase tracking-wide text-text-soft">Character</label>
                              <select
                                value={castCharacters.find((character) => character.voiceId === segment.voiceId)?.name || ''}
                                onChange={(event) => updateSpeakerAssignment(segmentIndex, event.target.value)}
                                className={`mt-1 w-full rounded border bg-surface px-2 py-1 text-xs font-semibold text-text-strong ${activeSpeakerSegment === segmentIndex ? 'border-accent-line ring-1 ring-accent' : 'border-line-soft'}`}
                                aria-label={`Speaker for segment ${segmentIndex + 1}`}
                              >
                                {!castCharacters.some((character) => character.voiceId === segment.voiceId) && (
                                  <option value="">{segment.speaker} — {segment.voiceId}</option>
                                )}
                                {castCharacters.map((character) => (
                                  <option key={character.name} value={character.name}>
                                    {character.name} — {character.voiceId}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold uppercase tracking-wide text-text-soft">Text</label>
                              <textarea
                                value={speakerTextDrafts[segmentIndex] ?? segment.text}
                                onChange={(event) => {
                                  editorSnapshot.current.dirty = true;
                                  setSpeakerTextDrafts(current => ({ ...current, [segmentIndex]: event.target.value }));
                                }}
                                className="mt-1 min-h-20 w-full rounded border border-line-soft bg-surface p-2 text-xs leading-relaxed text-text-strong"
                                aria-label={`Text for speaker segment ${segmentIndex + 1}`}
                              />
                            </div>
                            <div className="flex gap-1 2xl:flex-col">
                              <button
                                type="button"
                                onClick={() => void previewSpeakerSegment(segmentIndex)}
                                disabled={segment.omitted || playingSpeakerSegment === segmentIndex}
                                className="rounded border border-line-soft px-2 py-1 text-xs text-text-strong disabled:opacity-50"
                              >
                                {segment.omitted ? 'No audio' : playingSpeakerSegment === segmentIndex ? 'Playing…' : '▶ Audio'}
                              </button>
                              {segment.omitted ? (
                                <button
                                  type="button"
                                  onClick={() => restoreOmittedSegment(segmentIndex)}
                                  className="rounded border border-accent px-2 py-1 text-xs font-semibold text-accent"
                                >
                                  Restore
                                </button>
                              ) : <button
                                type="button"
                                onClick={() => rerecordSpeakerSegment(segmentIndex)}
                                disabled={isRegenerating}
                                className="rounded border border-line bg-surface px-2 py-1 text-xs font-semibold text-foreground disabled:opacity-50"
                                title="Re-record this corrected turn and rebuild the containing audio chunk"
                              >
                                {isRegenerating ? 'Recording…' : 'Re-record'}
                              </button>}
                            </div>
                          </div>
                        )) : (
                          <p className="p-2 text-[11px] text-text-soft">No valid speaker segments were found in this chunk.</p>
                        )}
                        {speakerSegments.length > 0 && hasSpeakerEdits && (
                          <button
                            type="button"
                            onClick={() => void handleRegenerate(textWithSpeakerDrafts())}
                            disabled={isRegenerating || isTextLoading}
                            className={`mt-1 min-h-11 w-full rounded border border-accent-line px-2 py-1.5 text-xs font-semibold disabled:opacity-50 md:min-h-8 ${hasEditedText ? 'bg-surface text-accent' : 'bg-surface text-accent md:bg-accent md:text-background'}`}
                          >
                            {isRegenerating ? 'Re-recording…' : `Apply Changes & Re-record Chunk ${currentChapter.index + 1}`}
                          </button>
                        )}
                      </div>
                    )}
            </>} />
        </section>

        {/* Middle: HTML Viewer with highlighting */}
          <section aria-label="Original pane" className={`min-h-0 min-w-0 flex-1 overflow-hidden relative flex-col border-r border-line-soft ${mobilePane === 'original' ? 'flex' : 'hidden'} ${showMiddlePane ? 'md:flex' : 'md:hidden'}`}>
          <div className="p-4 shrink-0 border-b border-line-soft bg-surface flex justify-between items-center">
            <span className="font-semibold text-text-strong">Original Text (Pre-Cleanup)</span>
          </div>
          <div className="flex-1 relative overflow-y-auto">
            {isTextLoading ? (
              <div className="absolute inset-0 flex items-center justify-center">Loading text...</div>
            ) : (
              <div className="absolute inset-0 px-4">
                <HTMLViewer
                  blocks={blocks}
                  isTxt={true}
                  isLoading={false}
                />
              </div>
            )}
          </div>
          </section>

        {/* Right side: Editor */}
          <section aria-label="Edit pane" className={`min-h-0 min-w-0 flex-1 flex-col bg-surface-raised border-l border-line-soft ${mobilePane === 'edit' ? 'flex' : 'hidden'} ${showRightPane ? 'md:flex' : 'md:hidden'}`}>
            <div className="p-4 border-b border-line-soft flex justify-between items-center bg-surface shrink-0">
              <h2 className="font-semibold text-text-strong truncate pr-2" title="Edit text (after Smart AI Processing)">
                {isGeminiDrama && !showGeminiFullText ? 'Gemini Drama · Speaker Review' : 'Edited Text'}
              </h2>
              {isDirty && <Button size="sm" variant="ghost" onClick={revertEdits} disabled={isRegenerating}>Revert</Button>}
              {isGeminiDrama && <button type="button" onClick={() => setShowGeminiFullText((value) => !value)}
                className="shrink-0 rounded border border-line-soft px-2 py-1 text-xs text-text-strong">
                {showGeminiFullText ? 'Speaker turns' : 'Edit full text'}
              </button>}
            </div>
            <div className={`flex-1 p-4 relative ${isGeminiDrama && !showGeminiFullText ? 'overflow-y-auto' : 'overflow-hidden'}`}>
              {isGeminiDrama && !showGeminiFullText && currentChapter ? (
                <GeminiDramaSpeakerReview key={`${bookId}-${currentChapter.index}`} bookId={bookId}
                  chapterIndex={currentChapter.index} profileId={selectedSmartAudioProfile?.id || selectedProfileId}
                  chapterText={chapterText} hasEditedText={hasEditedText} />
              ) : <textarea
                aria-label="Edited chapter text"
                disabled={isTextLoading || isRegenerating}
                value={chapterText}
                onChange={(e) => {
                  editorSnapshot.current.dirty = true;
                  setHasEditedText(true);
                  setChapterText(e.target.value);
                }}
                onSelect={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  const start = target.selectionStart;
                  const end = target.selectionEnd;
                  if (start !== end && start !== undefined) {
                    // Only capture if it's a reasonably sized word (e.g., < 50 chars)
                    const text = target.value.substring(start, end).trim();
                    if (text && text.length < 50) {
                      setSelectedText(text);
                    }
                  }
                }}
                className="absolute inset-4 w-[calc(100%-2rem)] h-[calc(100%-2rem)] bg-surface border border-line-soft rounded-lg text-text-strong p-4 text-sm font-mono leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-accent"
                placeholder="Edit the text here..."
              />}
            </div>
            {isDirty && <div className="border-t border-line-soft bg-surface p-2 text-xs text-soft">
              Unsaved changes · Changes are not reflected in the audio until you Save &amp; Re-record.
            </div>}
          </section>
      </div>

      {isDirty && <div className="flex-none border-t border-line-soft bg-surface px-3 py-2 md:hidden">
        <Button variant="primary" className="min-h-11 w-full" disabled={isRegenerating || isTextLoading} onClick={() => void handleRegenerate()}>{isRegenerating ? 'Re-recording…' : 'Save & Re-record'}</Button>
      </div>}
      {/* Simple Audio Player for pre-recorded chapter MP3 */}
      <div className="p-4 bg-surface-raised border-t border-line-soft flex items-center justify-center">
        {!isTextLoading && chapterText.length > 0 ? (
          <audio 
            key={`${bookId}-${currentChapter.index}-${audioRevision}`}
            controls 
            autoPlay
            onTimeUpdate={(event) => setActiveSpeakerSegment(activeSpeakerAtPlaybackTime(
              event.currentTarget.currentTime,
              event.currentTarget.duration,
            ))}
            onEnded={() => setActiveSpeakerSegment(null)}
            className="w-full max-w-2xl"
            src={`/api/audiobook/chapter?bookId=${bookId}&chapterIndex=${currentChapter.index}&revision=${audioRevision}`}
          />
        ) : (
          <div className="text-text-soft text-sm py-3">Loading audio...</div>
        )}
      </div>
      
      <BookPronunciationInspectorModal
        isOpen={isPronunciationModalOpen}
        onClose={() => setIsPronunciationModalOpen(false)}
        initialBookId="" // Use global by default
        initialSearchQuery={selectedText}
        initialUseFuzzySearch={!!selectedText} // Auto-fuzzy search if they selected a word
      />

      <ModalFrame open={isSettingsModalOpen} onClose={() => setIsSettingsModalOpen(false)} size="xl">
        <div className="flex flex-col max-h-[90vh] overflow-hidden bg-surface rounded-xl border border-line-soft">
          <div className="flex justify-between items-center p-4 border-b border-line-soft bg-surface-raised shrink-0">
            <h2 className="text-xl font-bold text-text-strong">AI Settings & Profiles</h2>
            <button aria-label="Close AI settings" title="Close AI settings" onClick={() => setIsSettingsModalOpen(false)} className="text-text-soft hover:text-text-strong text-2xl px-2 leading-none">&times;</button>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
            <SmartAudioSettings />
          </div>
        </div>
      </ModalFrame>

      <ModalFrame open={isQuickAbbrevModalOpen} onClose={() => setIsQuickAbbrevModalOpen(false)} size="md">
        <div className="bg-surface rounded-xl border border-line-soft overflow-hidden">
          <div className="flex justify-between items-center p-4 border-b border-line-soft bg-surface-raised">
            <div>
              <h2 className="font-bold text-text-strong">Quick Abbreviation</h2>
              <p className="text-xs text-text-soft mt-1">Replace a word or Roman numeral with plain text.</p>
            </div>
            <button aria-label="Close abbreviation editor" title="Close abbreviation editor" onClick={() => setIsQuickAbbrevModalOpen(false)} className="text-text-soft hover:text-text-strong text-xl px-2">&times;</button>
          </div>
          <div className="p-6 flex flex-col gap-4">
            <div>
              <label className="block text-xs font-semibold text-text-strong mb-1">Text in book (e.g. &quot;II&quot;)</label>
              <input 
                type="text" 
                value={newAbbrevKey} 
                onChange={(e) => setNewAbbrevKey(e.target.value)}
                className="w-full p-2 border border-line-soft rounded bg-surface-sunken text-text-strong"
                placeholder="Abbreviation or numeral"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-strong mb-1">Spoken text (e.g. &quot;point 2&quot;)</label>
              <input 
                type="text" 
                value={newAbbrevVal} 
                onChange={(e) => setNewAbbrevVal(e.target.value)}
                className="w-full p-2 border border-line-soft rounded bg-surface-sunken text-text-strong"
                placeholder="How it should be read"
              />
            </div>
            <button 
              disabled={!newAbbrevKey.trim() || !newAbbrevVal.trim()}
              onClick={async () => {
                if (!newAbbrevKey.trim() || !newAbbrevVal.trim()) return;
                try {
                  const updatedProfiles = smartAudioProfiles.map(p => {
                    if (p.id === selectedProfileId) {
                      return {
                        ...p,
                        abbreviations: {
                          ...(p.abbreviations || {}),
                          [newAbbrevKey.trim()]: newAbbrevVal.trim()
                        }
                      };
                    }
                    return p;
                  });
                  
                  const response = await fetch('/api/tts-settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      smartAudioProfiles: updatedProfiles,
                      selectedSmartAudioProfileId: selectedProfileId
                    }),
                  });
                  if (!response.ok) throw new Error('Failed to save abbreviation');
                  const saved = await response.json();
                  setSmartAudioProfiles(Array.isArray(saved.smartAudioProfiles) ? saved.smartAudioProfiles : updatedProfiles);
                  toast.success(`Added abbreviation: ${newAbbrevKey} -> ${newAbbrevVal}`);
                  setIsQuickAbbrevModalOpen(false);
                  setNewAbbrevKey('');
                  setNewAbbrevVal('');
                  
                  // Auto-apply to current text so they see it instantly!
                  setTimeout(() => {
                    handleFixAbbreviations();
                  }, 100);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Failed to save abbreviation');
                }
              }}
              className="mt-2 w-full py-2 bg-accent hover:bg-secondary-accent text-white rounded font-semibold transition-colors disabled:opacity-50"
            >
              Save Abbreviation
            </button>
          </div>
        </div>
      </ModalFrame>

      {/* Multi-Voice Studio Overlay */}
      {showMultiVoiceStudio && isMultiVoice && !isGeminiDrama && (
        <MultiVoiceReviewStudio
          bookId={bookId}
          chapterIndex={currentChapter.index}
          initialText={chapterText}
          onClose={() => setShowMultiVoiceStudio(false)}
          onRebuildAllModified={handleRebuildAllModified}
          isRebuildingAll={isRebuildingAll}
          onSaveAndRegenerate={async (newXml) => {
            setChapterText(newXml);
            editorSnapshot.current.dirty = true;
            setHasSpeakerChanges(true);
            // Trigger the regenerate logic with newXml
            setIsRegenerating(true);
            try {
              const res = await fetch(`/api/audiobook/chapter`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  bookId,
                  documentId: bookId,
                  chapterIndex: currentChapter.index,
                  chapterTitle: currentChapter.title,
                  text: newXml,
                  useSmartAudio: false,
                  format: currentChapter.format,
                }),
              });
              if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: string; detail?: string; message?: string };
                throw new Error(body.error || body.detail || body.message || "Failed to regenerate audio");
              }
              setAudioRevision(value => value + 1);
              savedChapterText.current = newXml;
              setHasEditedText(false);
              setHasSpeakerChanges(false);
              setSpeakerTextDrafts({});
              toast.success("Successfully rebuilt background audiobook chapter!");
              setShowMultiVoiceStudio(false);
            } catch (err) {
              console.error(err);
              toast.error(err instanceof Error ? err.message : "Error regenerating audio.");
              throw err;
            } finally {
              setIsRegenerating(false);
            }
          }}
        />
      )}

      {/* Mobile Player Overlay */}
      {showMobilePlayer && (
        <MobileReviewPlayer
          bookId={bookId}
          chapterIndex={currentChapter.index}
          chapterTitle={currentChapter.title}
          audioUrl={`/api/audiobook/chapter?bookId=${bookId}&chapterIndex=${currentChapter.index}`}
          onFlagError={async (timeMs) => {
            const response = await fetch('/api/audiobook/review-flags', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                documentId: bookId,
                chapterIndex: currentChapter.index,
                timestampMs: timeMs,
              }),
            });
            if (!response.ok) {
              const body = await response.json().catch(() => ({})) as { error?: string };
              throw new Error(body.error || 'Failed to save review flag.');
            }
          }}
          onNextChapter={handleNextChapter}
          onPrevChapter={handlePrevChapter}
          onExit={() => setShowMobilePlayer(false)}
        />
      )}

      <ModalFrame open={showBatchRefineModal} onClose={() => setShowBatchRefineModal(false)} size="xl">
        <div className="bg-surface rounded-xl border border-line-soft overflow-hidden">
          <div className="flex justify-between items-center p-4 border-b border-line-soft bg-surface-raised">
            <h2 className="font-bold text-text-strong">✨ AI Batch Refine</h2>
            <button aria-label="Close batch refine" title="Close batch refine" onClick={() => setShowBatchRefineModal(false)} className="text-text-soft hover:text-text-strong text-2xl px-2 leading-none">&times;</button>
          </div>
          <div className="p-4 space-y-4">
            <p className="text-sm text-text-soft">
              This scans every canonical audiobook text chapter while preserving the extracted original files.
              Only chapters Gemini changes appear in the review. The active {batchRefineProfileName || 'Smart Audio'} profile
              uses the <span className="font-semibold">{batchRefineProfileCategory}</span> review flags.
            </p>
            <div>
              <label className="block text-sm font-medium mb-1">Refinement Rule / Instruction</label>
              <textarea
                className="w-full bg-surface border border-line-soft rounded p-2 h-32 text-sm"
                placeholder="e.g. Delete any full sentence or long quotation (5 or more words total) that is predominantly in a foreign language..."
                value={batchRefineRule}
                onChange={e => setBatchRefineRule(e.target.value)}
              />
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-text-strong">What should happen when Gemini makes a change?</legend>
              {(Object.keys(BATCH_REFINE_RECORDING_OPTION_HELP) as BatchRefineRecordingMode[]).map((mode) => {
                const option = BATCH_REFINE_RECORDING_OPTION_HELP[mode];
                const selected = batchRefineRecordingMode === mode;
                return (
                  <div key={mode} className={`rounded border p-3 ${selected ? 'border-accent-line bg-accent-wash' : 'border-line-soft bg-surface-raised'}`}>
                    <div className="flex items-center gap-3">
                      <input
                        id={`batch-refine-mode-${mode}`}
                        type="radio"
                        name="batch-refine-recording-mode"
                        checked={selected}
                        onChange={() => setBatchRefineRecordingMode(mode)}
                      />
                      <label htmlFor={`batch-refine-mode-${mode}`} className="flex-1 cursor-pointer text-sm font-semibold text-text-strong">
                        {option.label}{mode === 'review' ? ' (recommended)' : ' (opt in)'}
                      </label>
                      <button
                        type="button"
                        aria-label={`Explain ${option.label}`}
                        aria-expanded={batchRefineOptionHelp === mode}
                        onClick={() => setBatchRefineOptionHelp((current) => current === mode ? null : mode)}
                        className="rounded-full border border-accent-line bg-accent-wash px-2.5 py-1 text-xs font-semibold text-accent hover:bg-surface-sunken"
                      >
                        ⚑ What happens?
                      </button>
                    </div>
                    {batchRefineOptionHelp === mode && (
                      <p className="mt-2 rounded border border-line-soft bg-surface p-2 text-xs text-text-soft">{option.description}</p>
                    )}
                  </div>
                );
              })}
              {batchRefineRecordingMode === 'immediate' && (
                <label className="flex items-start gap-2 rounded border border-danger bg-danger-wash p-3 text-sm text-text-strong">
                  <input
                    type="checkbox"
                    checked={batchRefineHoldHighPriority}
                    onChange={(event) => setBatchRefineHoldHighPriority(event.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-semibold">Hold high-concern changes for review</span>
                    <span className="text-xs text-text-soft">Low- and medium-concern changes record immediately; high-concern changes wait for approval.</span>
                  </span>
                </label>
              )}
            </fieldset>
            <div className="bg-surface-raised p-3 border border-line-soft rounded text-sm text-text-soft">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-semibold w-24">AI Model:</span>
                <select 
                  className="bg-surface border border-line-soft rounded px-2 py-1 flex-1 text-text-strong"
                  value={batchRefineModel}
                  onChange={(e) => setBatchRefineModel(e.target.value)}
                >
                  {PRESET_MODELS.filter(m => m.id !== 'custom').map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold w-24 shrink-0">Profile:</span>
                <span className="text-text-strong">{batchRefineProfileName || 'Selected Smart Audio profile'}</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-semibold w-24 shrink-0">Gemini keys:</span>
                <code className="bg-surface px-2 py-0.5 rounded text-xs text-text-strong">{batchRefineKeys.primary}</code>
                <span>/</span>
                <code className="bg-surface px-2 py-0.5 rounded text-xs text-text-strong">{batchRefineKeys.backup}</code>
                <button
                  type="button"
                  onClick={() => {
                    setShowBatchRefineModal(false);
                    setIsSettingsModalOpen(true);
                  }}
                  className="ml-auto text-xs font-semibold text-accent hover:underline"
                >
                  Manage in AI Settings
                </button>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <a
                href={`/api/audiobooks/batch-refine/changelog?bookId=${encodeURIComponent(bookId)}${batchRefineRunId ? `&runId=${encodeURIComponent(batchRefineRunId)}` : ''}`}
                target="_blank"
                className="px-4 py-2 bg-surface-sunken hover:bg-surface-raised text-text-strong rounded text-sm transition-colors border border-line-soft mr-auto"
              >
                Raw Changelog
              </a>
              <button
                type="button"
                onClick={() => {
                  setShowBatchRefineModal(false);
                  setShowBatchRefineReview(true);
                }}
                className="px-4 py-2 border border-line-soft rounded text-sm hover:bg-surface-raised transition-colors"
              >
                Review Existing Changes
              </button>
              <button
                className="px-4 py-2 border border-line-soft rounded text-sm hover:bg-surface-raised transition-colors"
                onClick={() => setShowBatchRefineModal(false)}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 bg-accent hover:bg-secondary-accent text-white rounded text-sm transition-colors flex items-center gap-2"
                onClick={handleBatchRefine}
                disabled={isBatchRefining}
              >
                {isBatchRefining ? 'Queueing...' : 'Start Batch Refine'}
              </button>
            </div>
          </div>
        </div>
      </ModalFrame>

      <BatchRefineReviewModal
        open={showBatchRefineReview}
        onClose={() => setShowBatchRefineReview(false)}
        bookId={bookId}
        runId={activeBatchRefineRunId}
        onRecordingQueued={() => {
          void fetchStatus();
          if (selectedChapterIndex !== undefined) void fetchChapterText(selectedChapterIndex, true);
        }}
      />

      <PronunciationIssuesModal open={showPronunciationIssues} onClose={() => setShowPronunciationIssues(false)} bookId={bookId} profileId={selectedProfileId} onRecordingQueued={() => {
        void fetchStatus();
        if (selectedChapterIndex !== undefined) void fetchChapterText(selectedChapterIndex, true);
      }} />

      <AudiobookshelfModal
        open={showAudiobookshelfModal}
        onClose={() => setShowAudiobookshelfModal(false)}
        bookId={bookId}
        chapters={chapters}
        onReviewChapters={() => {
          setChapterFilter('needs_review');
          setShowLeftPane(true);
          setMobilePane('chapters');
        }}
      />

      <ReviewAiCleanDialog open={showAiClean} onClose={() => setShowAiClean(false)} target={cleanTarget}
        onTarget={setCleanTarget} profiles={smartAudioProfiles} profileId={selectedProfileId} onProfile={setSelectedProfileId}
        onSettings={() => { setShowAiClean(false); setIsSettingsModalOpen(true); }} onClean={handleAiClean} busy={isRegenerating || isTextLoading} />
      <ReviewUnsavedChangesDialog open={pendingChapterIndex !== null} title={currentChapter.title} busy={isRegenerating}
        onStay={() => setPendingChapterIndex(null)} onDiscard={discardAndNavigate} onSave={() => void saveAndNavigate()} />
      <ModalFrame open={showForceRecord} onClose={() => setShowForceRecord(false)} size="sm">
        <ModalTitle>Force Re-record All?</ModalTitle>
        <p className="my-4 text-sm text-foreground">This replaces all existing audio for this book. Every chapter will be re-recorded.</p>
        <div className="flex justify-end gap-2"><Button onClick={() => setShowForceRecord(false)}>Cancel</Button><Button variant="danger" onClick={() => void handleForceRebuildAll()} disabled={isRebuildingAll}>Force Re-record All</Button></div>
      </ModalFrame>

      {errorLogModalChapter && (
        <ChapterErrorLogModal
          open={true}
          onClose={() => setErrorLogModalChapter(null)}
          bookId={bookId}
          chapterIndex={errorLogModalChapter.index}
          chapterTitle={errorLogModalChapter.title}
          onNavigateToChapter={(idx) => {
            const pos = chapters.findIndex((c) => c.index === idx);
            if (pos >= 0) requestChapterSelection(idx);
            setErrorLogModalChapter(null);
          }}
        />
      )}

    </div>
  );
}
