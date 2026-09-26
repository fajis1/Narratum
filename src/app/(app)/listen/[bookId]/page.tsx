"use client";

import { useState, useEffect, useRef, use, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HTMLViewer } from "@/components/views/HTMLViewer";
import { parseHtmlBlocks } from "@/lib/client/html/blocks";
import { BookPronunciationInspectorModal } from "@/components/doclist/BookPronunciationInspectorModal";
import { MultiVoiceReviewStudio } from "@/components/audiobooks/MultiVoiceReviewStudio";
import { MobileReviewPlayer } from "@/components/audiobooks/MobileReviewPlayer";
import { BatchRefineReviewModal } from "@/components/audiobooks/BatchRefineReviewModal";
import { PronunciationIssuesModal } from "@/components/audiobooks/PronunciationIssuesModal";
import { AudiobookshelfModal } from "@/components/audiobooks/AudiobookshelfModal";
import { ChapterErrorLogModal } from "@/components/audiobooks/ChapterErrorLogModal";
import { BASE_BOOKS, PRESET_MODELS } from "@/components/constants";
import { toast } from "react-hot-toast";
import { ModalFrame } from "@/components/ui";
import { SmartAudioSettings } from "@/components/SmartAudioSettings";
import { estimateSpeakerSegmentAtTime, parseVoiceTaggedText, renderVoiceSegments } from "@/lib/shared/multi-voice";
import type { SmartAudioCharacterMap, SmartAudioReviewFlag } from "@/types/document-settings";
import { AUDIOBOOK_WAITING_FOR_GPU_PHASE } from "@/lib/shared/audiobook-runtime-phase";
import {
  BATCH_REFINE_RECORDING_OPTION_HELP,
  type BatchRefineRecordingMode,
} from "@/lib/shared/batch-refine-review";

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
  const [activeJob, setActiveJob] = useState<any>(null);
  const [isTextLoading, setIsTextLoading] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isRebuildingAll, setIsRebuildingAll] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [isPronunciationModalOpen, setIsPronunciationModalOpen] = useState(false);
  const [isQuickAbbrevModalOpen, setIsQuickAbbrevModalOpen] = useState(false);
  const [newAbbrevKey, setNewAbbrevKey] = useState('');
  const [newAbbrevVal, setNewAbbrevVal] = useState('');
  const [selectedText, setSelectedText] = useState("");
  
  const [showMultiVoiceStudio, setShowMultiVoiceStudio] = useState(false);
  const [showMobilePlayer, setShowMobilePlayer] = useState(false);
  const [smartAudioProfiles, setSmartAudioProfiles] = useState<any[]>([]);
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

  const isChapterNeedingReview = useCallback((chap: Chapter): boolean => {
    return Boolean(
      chap.hasRejected ||
      chap.hasFailure ||
      chap.needsReview ||
      chap.isEmptyText ||
      chap.hasAudio === false ||
      chap.status === 'error' ||
      reviewFlags.some((f) => f.chapterIndex === chap.index)
    );
  }, [reviewFlags]);

  const reviewChaptersCount = useMemo(() => {
    return chapters.filter((c) => isChapterNeedingReview(c)).length;
  }, [chapters, isChapterNeedingReview]);

  const visibleChapters = useMemo(() => {
    let list = [...chapters];

    if (chapterSearch.trim()) {
      const q = chapterSearch.trim().toLowerCase();
      list = list.filter((c) => {
        const chunkLabel = `chunk ${c.index + 1}`.toLowerCase();
        const titleLabel = (c.title || '').toLowerCase();
        return chunkLabel.includes(q) || titleLabel.includes(q);
      });
    }

    if (chapterFilter === 'needs_review') {
      list = list.filter((c) => isChapterNeedingReview(c));
    }

    if (chapterSort === 'review_first') {
      list.sort((a, b) => {
        const aNeeds = isChapterNeedingReview(a) ? 1 : 0;
        const bNeeds = isChapterNeedingReview(b) ? 1 : 0;
        if (bNeeds !== aNeeds) return bNeeds - aNeeds;
        return a.index - b.index;
      });
    } else {
      list.sort((a, b) => a.index - b.index);
    }

    return list;
  }, [chapters, chapterFilter, chapterSort, chapterSearch, isChapterNeedingReview]);

  useEffect(() => {
    if (chapterFilter === 'needs_review' && visibleChapters.length > 0) {
      const currentIsVisible = visibleChapters.some((c) => c.index === currentChapter?.index);
      if (!currentIsVisible) {
        const targetIndex = chapters.findIndex((c) => c.index === visibleChapters[0].index);
        if (targetIndex >= 0) setCurrentChapterPosition(targetIndex);
      }
    }
  }, [chapterFilter, visibleChapters, currentChapter?.index, chapters]);

  const currentVisibleIndex = visibleChapters.findIndex((c) => c.index === currentChapter?.index);
  const canGoPrev = currentVisibleIndex > 0;
  const canGoNext = currentVisibleIndex >= 0 && currentVisibleIndex < visibleChapters.length - 1;

  const handlePrevChapter = () => {
    if (canGoPrev) {
      const target = visibleChapters[currentVisibleIndex - 1];
      const targetIdx = chapters.findIndex((c) => c.index === target.index);
      if (targetIdx >= 0) setCurrentChapterPosition(targetIdx);
    } else if (currentChapterPosition > 0) {
      setCurrentChapterPosition((i) => i - 1);
    }
  };

  const handleNextChapter = () => {
    if (canGoNext) {
      const target = visibleChapters[currentVisibleIndex + 1];
      const targetIdx = chapters.findIndex((c) => c.index === target.index);
      if (targetIdx >= 0) setCurrentChapterPosition(targetIdx);
    } else if (currentChapterPosition < chapters.length - 1) {
      setCurrentChapterPosition((i) => i + 1);
    }
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

  useEffect(() => {
    setSpeakerTextDrafts(Object.fromEntries(
      speakerSegments.map((segment, index) => [index, segment.text]),
    ));
  }, [currentChapterPosition, speakerSegments]);

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

  const fetchStatus = async () => {
    try {
      const res = await fetch(`/api/audiobook/status?bookId=${bookId}`);
      const data = await res.json();
      if (data.chapters && data.chapters.length > 0) {
        setCurrentChapterPosition((position) => Math.min(position, data.chapters.length - 1));
        setChapters((prev) => {
          // Only update if something changed to avoid unnecessary re-renders
          if (JSON.stringify(prev) !== JSON.stringify(data.chapters)) {
            return data.chapters;
          }
          return prev;
        });
      } else {
        setChapters([]);
      }
    } catch (err) {
      console.error("Failed to fetch audiobook status", err);
    } finally {
      setLoading(false);
    }
  };

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
      } catch(e) {}
    };
    
    checkJob();

    // Poll every 5 seconds to get live updates for background tasks
    const interval = setInterval(() => {
       fetchStatus();
       checkJob();
    }, 5000);
    return () => clearInterval(interval);
  }, [bookId]);

  const fetchReviewFlags = async () => {
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
  };

  useEffect(() => {
    void fetchReviewFlags();
  }, [bookId]);

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

  useEffect(() => {
    if (selectedChapterIndex !== undefined) {
      // Reset edit state when navigating to a new chapter
      setHasEditedText(false);
      fetchChapterText(selectedChapterIndex);
    }
  }, [selectedChapterIndex]);

  // Poll for text updates if we haven't manually edited
  useEffect(() => {
    if (hasEditedText || selectedChapterIndex === undefined) return;
    const interval = setInterval(() => {
      fetchChapterText(selectedChapterIndex, true);
    }, 5000);
    return () => clearInterval(interval);
  }, [hasEditedText, selectedChapterIndex]);

  const fetchChapterText = async (index: number, isBackgroundPoll = false) => {
    if (!isBackgroundPoll) setIsTextLoading(true);
    try {
      const [resText, resOrig] = await Promise.all([
        fetch(`/api/audiobook/text?bookId=${bookId}&chapterIndex=${index}&t=${Date.now()}`, { cache: 'no-store' }),
        fetch(`/api/audiobook/text?bookId=${bookId}&chapterIndex=${index}&type=original&t=${Date.now()}`, { cache: 'no-store' })
      ]);
      
      if (resOrig.ok) {
        const origText = await resOrig.text();
        setOriginalText((prev) => (prev !== origText ? origText : prev));
      } else if (!isBackgroundPoll) {
        setOriginalText("");
      }

      if (resText.ok) {
        const text = await resText.text();
        setChapterText((prev) => (prev !== text ? text : prev));
      } else if (!isBackgroundPoll) {
        setChapterText("No text available for this chapter.");
      }
    } catch (err) {
      console.error(err);
      if (!isBackgroundPoll) {
        setChapterText("Failed to load text.");
        setOriginalText("");
      }
    } finally {
      if (!isBackgroundPoll) setIsTextLoading(false);
    }
  };

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
    setHasEditedText(true);
    toast.success("Abbreviations expanded successfully!");
  };

  const handleRegenerate = async (textOverride?: string) => {
    const textToRecord = textOverride || chapterText;
    if (!textToRecord || !currentChapter) return;
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
          useSmartAudio: false,
          format: currentChapter.format,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string; detail?: string; message?: string };
        const msg = body.error || body.detail || body.message || `Failed to regenerate audio (${res.status})`;
        throw new Error(msg);
      }
      
      toast.success("Successfully queued regeneration");
    } catch (error: any) {
      console.error(error);
      toast.error(error.message || "Failed to trigger regeneration");
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
          useSmartAudio: false,
          format: chapter.format,
        }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Failed to queue chapter recovery.');
      setCurrentChapterPosition(chapters.findIndex((candidate) => candidate.index === chapter.index));
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
      setHasEditedText(true);
    } catch {
      toast.error('This chunk has invalid speaker markup and cannot be reassigned safely.');
    }
  };

  const updateSpeakerText = (segmentIndex: number, text: string) => {
    try {
      const parsed = parseVoiceTaggedText(chapterText, { includeOmitted: true });
      if (!parsed[segmentIndex] || !text.trim()) return;
      parsed[segmentIndex] = { ...parsed[segmentIndex], text: text.trim() };
      setChapterText(renderVoiceSegments(parsed));
      setHasEditedText(true);
    } catch {
      toast.error('This chunk has invalid speaker markup and cannot be edited safely.');
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
      setHasEditedText(true);
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
      setHasEditedText(true);
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
    } catch (e: any) {
      toast.error(e.message || 'Error scanning books');
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
    } catch(e) {}
  };

  const handleCancelBatchRefine = async () => {
    if (!activeJob?.id) return;
    try {
      await fetch(`/api/audiobooks/queue?id=${activeJob.id}`, { method: 'DELETE' });
      setIsBatchRefining(false);
      setActiveJob(null);
    } catch(e) {}
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
    } catch (e: any) {
      toast.error(e.message || 'Error starting batch refine');
    } finally {
      setIsBatchRefining(false);
    }
  };

  const handleForceRebuildAll = async () => {
    if (!window.confirm("Are you sure you want to re-record every single chunk? This will replace all existing audio for this book!")) {
      return;
    }
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
    } catch (e: any) {
      toast.error(e.message || 'Error starting force rebuild');
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
    } catch (e: any) {
      toast.error(e.message || 'Error fixing abbreviations');
    } finally {
      setIsFixingAll(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950 text-slate-200">
        <div>Loading...</div>
      </div>
    );
  }

  if (chapters.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-slate-950 text-slate-200">
        <h1 className="text-2xl font-bold mb-4">No Audiobook Available</h1>
        <button className="mb-3 rounded border border-line-soft px-4 py-2" onClick={() => setShowPronunciationIssues(true)}>Scan Pronunciation Issues</button>
        <PronunciationIssuesModal open={showPronunciationIssues} onClose={() => setShowPronunciationIssues(false)} bookId={bookId} profileId={selectedProfileId} onRecordingQueued={() => void fetchStatus()} />
        <button className="px-4 py-2 bg-blue-600 rounded" onClick={() => router.push("/app")}>Return to Dashboard</button>
      </div>
    );
  }

  if (!currentChapter) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950 text-slate-200">
        <div>Loading chapter...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-surface">
      <div className="flex-none p-4 bg-surface border-b border-line-soft flex items-center justify-between">
        
        <div>
          <h1 className="text-xl font-bold text-text-strong line-clamp-1">Review: {currentChapter.title}</h1>
          <p className="text-text-soft text-sm">
            Chunk {currentChapter.index + 1}
            {chapterFilter === 'needs_review'
              ? ` · Flagged ${currentVisibleIndex >= 0 ? currentVisibleIndex + 1 : 1} of ${visibleChapters.length} (${chapters.length} total)`
              : ` · Item ${currentChapterPosition + 1} of ${chapters.length}`}
          </p>
        </div>
        {activeJob && (activeJob.status === 'running' || activeJob.status === 'queued') && (
          <div className="mt-2 flex items-center gap-4 bg-indigo-50 border border-indigo-200 rounded-md px-3 py-1.5 shadow-sm">
            <div className="flex-1 flex items-center gap-3">
              <span className="text-indigo-900 font-bold text-sm shrink-0">
                {isWaitingForGpu
                  ? 'Generating audiobook · Waiting for GPU'
                  : activeJobSettings.jobType === 'batch-refine'
                    ? 'AI Batch Refine'
                    : 'Background Job'}
              </span>
              <div className="flex-1 max-w-sm bg-indigo-200 rounded-full h-2">
                <div className="bg-indigo-600 h-2 rounded-full transition-all duration-500" style={{ width: `${activeJob.progress || 0}%` }}></div>
              </div>
              <span className="text-indigo-800 font-mono text-sm font-semibold w-10">{Math.round(activeJob.progress || 0)}%</span>
              {isWaitingForGpu && (
                <span className="max-w-sm text-xs text-indigo-800">
                  Kokoro will start automatically when the shared GPU is ready.
                </span>
              )}
              {activeJobSettings.jobType === 'batch-refine' && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowBatchRefineReview(true)}
                    className="shrink-0 rounded bg-accent px-2.5 py-1 text-xs font-semibold text-background hover:bg-secondary-accent"
                  >
                    Review Changes
                  </button>
                  <a
                    href={`/api/audiobooks/batch-refine/changelog?bookId=${encodeURIComponent(bookId)}${activeBatchRefineRunId ? `&runId=${encodeURIComponent(activeBatchRefineRunId)}` : ''}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-xs font-semibold text-accent hover:text-accent-strong hover:underline"
                  >
                    Raw Changelog
                  </a>
                </>
              )}
            </div>
            <button 
              onClick={async () => {
                try {
                  await fetch(`/api/audiobooks/queue?id=${activeJob.id}`, { method: 'DELETE' });
                  setActiveJob(null);
                  setIsBatchRefining(false);
                } catch (e) {}
              }}
              className="text-xs text-rose-600 hover:text-rose-700 bg-white border border-rose-200 hover:border-rose-300 font-semibold px-2 py-1 rounded shadow-sm transition-colors shrink-0"
            >
              Stop & Cancel
            </button>
          </div>
        )}
        <div className="flex gap-2 items-center flex-wrap">
          {/* View Toggles */}
          <div className="flex bg-surface-raised border border-line-soft rounded overflow-hidden">
            <button onClick={() => setShowLeftPane(!showLeftPane)} className={`px-3 py-1.5 text-xs font-medium transition-colors ${showLeftPane ? 'bg-accent text-background' : 'text-foreground hover:bg-surface-sunken'}`}>List</button>
            <button onClick={() => setShowMiddlePane(!showMiddlePane)} className={`px-3 py-1.5 text-xs font-medium border-l border-line-soft transition-colors ${showMiddlePane ? 'bg-accent text-background' : 'text-foreground hover:bg-surface-sunken'}`}>Original</button>
            <button onClick={() => setShowRightPane(!showRightPane)} className={`px-3 py-1.5 text-xs font-medium border-l border-line-soft transition-colors ${showRightPane ? 'bg-accent text-background' : 'text-foreground hover:bg-surface-sunken'}`}>Edit</button>
          </div>

          {isMultiVoice && (
            <button
              onClick={() => setShowMultiVoiceStudio(true)}
              className="hidden md:flex px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium text-sm gap-2"
            >
              🎬 Open Audio-Drama Studio
            </button>
          )}
          <button
            onClick={() => setShowMobilePlayer(true)}
            className="md:hidden px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded font-medium text-sm gap-2"
          >
            📱 Mobile Player
          </button>
          <button onClick={() => setShowPronunciationIssues(true)} className="rounded border border-line-soft bg-surface-raised px-3 py-1.5 text-xs font-medium text-text-strong">Scan Pronunciation Issues</button>
          <button
            onClick={() => setShowAudiobookshelfModal(true)}
            className="rounded border border-line-soft bg-surface-raised px-3 py-1.5 text-xs font-medium text-text-strong hover:bg-surface-sunken flex items-center gap-1.5"
            title="Export this audiobook and companion document to Audiobookshelf"
          >
            <span>📚</span> Add to Audiobookshelf
          </button>
          <div className="hidden md:flex gap-2 items-center border-l border-line-soft pl-2 ml-1">
            <button
              onClick={handleFixAllAbbreviations}
              disabled={isFixingAll || isRebuildingAll || chapters.length === 0}
              className="px-3 py-1.5 bg-indigo-600/10 hover:bg-indigo-600/20 text-indigo-400 rounded font-medium text-xs disabled:opacity-50 transition-colors"
              title="Apply abbreviation fixes to all chunks in this book"
            >
              {isFixingAll ? "Fixing..." : "Fix All Abbreviations"}
            </button>
            <button 
              onClick={handleRebuildAllModified} 
              disabled={isRebuildingAll || chapters.length === 0}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md shadow font-bold text-xs disabled:opacity-50 transition-all"
              title="Re-record MP3s for any chunk where the text was modified"
            >
              {isRebuildingAll ? "Scanning..." : "Re-Record All Modified chunks"}
            </button>
            <button
              onClick={handleOpenBatchRefine}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium text-xs transition-colors flex items-center gap-1"
              title="Apply a custom AI rule to all chapters"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
              AI Batch Refine
              <svg className="w-3.5 h-3.5 opacity-60 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <title>Apply a specific, surgical instruction (like removing specific words or fixing a recurring typo) to every single chapter in the entire book.</title>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            <button
              onClick={() => setShowBatchRefineReview(true)}
              className="px-3 py-1.5 bg-surface-raised hover:bg-surface-sunken text-text-strong border border-line-soft rounded font-medium text-xs transition-colors"
              title="Review only the chapters changed by the latest AI Batch Refine run"
            >
              Review AI Changes
            </button>
            <button
              onClick={handleForceRebuildAll}
              disabled={isRebuildingAll || chapters.length === 0}
              className="px-3 py-1.5 bg-rose-600/10 hover:bg-rose-600/20 text-rose-500 rounded font-medium text-xs disabled:opacity-50 transition-colors"
              title="Force re-record every single chunk (useful if you changed voices)"
            >
              Force Re-Record All
            </button>
          </div>
          <div className="flex gap-1 ml-auto md:ml-2">
            <button
              className="px-3 py-1.5 border border-line-soft rounded text-sm disabled:opacity-50"
              onClick={handlePrevChapter}
              disabled={chapterFilter === 'needs_review' ? !canGoPrev : currentChapterPosition === 0}
            >
              {chapterFilter === 'needs_review' ? 'Prev Flagged' : 'Prev Chapter'}
            </button>
            <button
              className="px-3 py-1.5 border border-line-soft rounded text-sm disabled:opacity-50"
              onClick={handleNextChapter}
              disabled={chapterFilter === 'needs_review' ? !canGoNext : currentChapterPosition === chapters.length - 1}
            >
              {chapterFilter === 'needs_review' ? 'Next Flagged' : 'Next Chapter'}
            </button>
          </div>
        </div>
      </div>

      {(reviewFlags.length > 0 || reviewFlagsError) && (
        <section className="flex-none border-b border-amber-300/30 bg-amber-50 px-4 py-3 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100" aria-label="Audiobook review flags">
          <div className="mx-auto flex max-w-7xl flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">Audiobook review flags</h2>
                <p className="text-xs opacity-80">These chapter segments need a listening check after Cloud Drama generation.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setErrorLogModalChapter({ index: null })}
                  className="rounded border border-amber-700/40 bg-white/50 hover:bg-white/80 dark:bg-black/20 dark:hover:bg-black/40 px-2.5 py-1 text-xs font-semibold flex items-center gap-1 transition-colors"
                  title="Inspect all chapter validation errors and diagnostic logs"
                >
                  <span>📋 View All Error Logs</span>
                </button>
                <button type="button" onClick={() => void fetchReviewFlags()} className="rounded border border-amber-700/40 px-2.5 py-1 text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/40">Refresh</button>
              </div>
            </div>
            {reviewFlagsError && <p className="text-xs text-red-700 dark:text-red-300">{reviewFlagsError}</p>}
            <div className="grid gap-2 lg:grid-cols-2">
              {reviewFlags.map((flag) => {
                const chapter = chapters.find((candidate) => candidate.index === flag.chapterIndex);
                return (
                  <article key={flag.id} className="rounded border border-amber-700/30 bg-white/60 p-3 dark:bg-black/20">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 text-xs">
                        <p className="font-semibold">Chapter {(flag.chapterIndex ?? 0) + 1}{flag.speaker ? ` · ${flag.speaker}` : ''}</p>
                        {flag.kind && <p className="mt-1 capitalize opacity-80">{flag.kind.replaceAll('-', ' ')}</p>}
                        {flag.sourceText && <p className="mt-1 line-clamp-2 opacity-80">“{flag.sourceText}”</p>}
                        {flag.reason && <p className="mt-1 opacity-80">{flag.reason}</p>}
                      </div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setErrorLogModalChapter({ index: flag.chapterIndex, title: chapter?.title })}
                          className="rounded border border-amber-700/40 px-2 py-1 text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/40"
                          title="View failure log and validation details for this chapter"
                        >
                          📋 Details
                        </button>
                        <button
                          type="button"
                          onClick={() => void retryReviewFlag(flag)}
                          disabled={!chapter || retryingReviewFlagId === flag.id}
                          className="rounded bg-amber-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
                        >
                          {retryingReviewFlagId === flag.id ? 'Queuing…' : 'Retry chapter'}
                        </button>
                        <button type="button" onClick={() => void resolveReviewFlag(flag.id)} className="rounded border border-amber-700/40 px-2.5 py-1 text-xs font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/40">Resolve</button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Global Actions Toolbar */}
      <div className="flex-none p-2 bg-surface border-b border-line-soft flex items-center justify-between flex-wrap gap-2 shadow-sm relative z-10">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-text-soft tracking-wider mr-2 uppercase">Chunk {currentChapter.index + 1} Actions:</span>

          {(currentChapter.status === 'error' || currentChapter.hasFailure || currentChapter.hasRejected || reviewFlags.some(f => f.chapterIndex === currentChapter.index)) && (
            <button
              type="button"
              onClick={() => setErrorLogModalChapter({ index: currentChapter.index, title: currentChapter.title })}
              className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/40 px-3 py-1.5 rounded text-xs font-semibold shrink-0 flex items-center gap-1.5 transition-colors"
              title="Inspect validation errors and diagnostic log for this chunk"
            >
              <span>📋 View Error Log</span>
            </button>
          )}
          
          <button
            onClick={() => setIsPronunciationModalOpen(true)}
            className="bg-surface-raised border border-line-soft hover:bg-surface-sunken text-text-strong px-3 py-1.5 rounded text-xs font-medium shrink-0"
            title="Double-click a word in the text to highlight it, then click here to instantly find and fix its pronunciation"
          >
            Dictionary 🔍
          </button>

          <button
            onClick={() => {
              setNewAbbrevKey('');
              setNewAbbrevVal('');
              setIsQuickAbbrevModalOpen(true);
            }}
            className="bg-surface-raised border border-line-soft hover:bg-surface-sunken text-text-strong px-3 py-1.5 rounded text-xs font-medium shrink-0"
            title="Quickly add a word replacement or abbreviation"
          >
            Abbreviations ✏️
          </button>
          
          <button
            onClick={handleFixAbbreviations}
            className="bg-indigo-600/10 border border-indigo-600/20 hover:bg-indigo-600/20 text-indigo-400 px-3 py-1.5 rounded text-xs font-medium transition-colors"
            title="Instantly expand abbreviations without AI"
          >
            Fix Abbreviations
          </button>

          {smartAudioProfiles.length > 0 && (
            <div className="flex items-center gap-1 border-l border-line-soft pl-2 ml-1">
              <select 
                className="bg-surface text-text-strong border border-line-soft rounded px-2 py-1.5 text-xs font-medium outline-none"
                value={selectedProfileId}
                onChange={(e) => setSelectedProfileId(e.target.value)}
                disabled={isRegenerating || isTextLoading}
              >
                {smartAudioProfiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <button 
                onClick={() => setIsSettingsModalOpen(true)}
                className="p-1.5 text-text-soft hover:text-text-strong hover:bg-surface-raised rounded transition-colors"
                title="Edit AI Profiles in Settings"
              >
                ⚙️
              </button>
            </div>
          )}
          
          <div className="flex items-center gap-2 bg-surface-raised border border-line-soft rounded px-2 py-1 flex-wrap border-l border-line-soft pl-2 ml-1">
            <label className="flex items-center gap-1.5 text-xs text-text-strong font-medium cursor-pointer" title="Check this to send the Edited text on the right instead of the Original text">
              <input 
                type="checkbox" 
                checked={cleanTarget === 'edited'}
                onChange={(e) => setCleanTarget(e.target.checked ? 'edited' : 'original')}
                className="rounded border-line-soft text-indigo-500 focus:ring-indigo-500 cursor-pointer"
              />
              Clean Edited
            </label>
            <button
              onClick={() => {
                const textToSend = cleanTarget === 'edited' ? chapterText : (originalText || chapterText);
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
              }).catch(err => {
                console.error(err);
                toast.error(err.message || "Failed to trigger AI cleanup");
              }).finally(() => setIsRegenerating(false));
            }}
            disabled={isRegenerating || isTextLoading}
            className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50 flex items-center gap-1 shrink-0"
            title="Send this original text back to Gemini to try cleaning it again"
          >
            ✨ Clean with AI
            <svg className="w-3.5 h-3.5 opacity-60 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <title>Reprocess this single chapter using your currently selected Smart AI Profile. Useful if the original processing failed or was interrupted.</title>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
          </div>
        </div>
        
        <button 
            onClick={() => void handleRegenerate()}
          disabled={isRegenerating || isTextLoading}
          className="bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50 shrink-0"
        >
          {isRegenerating ? "Rebuilding..." : "Save to Audiobook"}
        </button>
      </div>

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Far Left side: Chapter List / Guesses */}
        {showLeftPane && (
          <div className={`w-full ${isMultiVoice ? 'md:w-1/2' : 'md:w-1/4'} flex flex-col border-r border-line-soft bg-surface h-1/3 md:h-full`}>
            <div className="p-3 border-b border-line-soft bg-surface-raised shrink-0 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-text-strong text-sm">
                  {isMultiVoice ? 'Chapters & Speakers' : 'Context / Chapter Guesses'}
                </span>
                {reviewChaptersCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-500/20 text-amber-500 border border-amber-500/30">
                    {reviewChaptersCount} need review
                  </span>
                )}
              </div>

              {/* Filter Tabs */}
              <div className="flex gap-1.5 p-1 bg-surface rounded-lg border border-line-soft text-xs">
                <button
                  type="button"
                  onClick={() => setChapterFilter('all')}
                  className={`flex-1 py-1 px-2 rounded-md font-medium transition-colors text-center ${
                    chapterFilter === 'all'
                      ? 'bg-accent text-background shadow-xs font-semibold'
                      : 'text-text-soft hover:text-text-strong'
                  }`}
                >
                  All ({chapters.length})
                </button>
                <button
                  type="button"
                  onClick={() => setChapterFilter('needs_review')}
                  className={`flex-1 py-1 px-2 rounded-md font-medium transition-colors text-center flex items-center justify-center gap-1 ${
                    chapterFilter === 'needs_review'
                      ? 'bg-amber-600 text-white shadow-xs font-semibold'
                      : reviewChaptersCount > 0
                      ? 'text-amber-500 hover:bg-amber-500/10'
                      : 'text-text-soft hover:text-text-strong'
                  }`}
                >
                  <span>⚠️ Needs Review</span>
                  <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${chapterFilter === 'needs_review' ? 'bg-amber-800 text-amber-100' : 'bg-amber-500/20 text-amber-500'}`}>
                    {reviewChaptersCount}
                  </span>
                </button>
              </div>

              {/* Sort & Search Toolbar */}
              <div className="flex items-center gap-1.5 text-xs">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={chapterSearch}
                    onChange={(e) => setChapterSearch(e.target.value)}
                    placeholder="Search chunk or title..."
                    className="w-full bg-surface border border-line-soft rounded px-2 py-1 text-xs text-text-strong placeholder:text-text-soft outline-none focus:border-accent"
                  />
                  {chapterSearch && (
                    <button
                      type="button"
                      onClick={() => setChapterSearch('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-text-soft hover:text-text-strong text-xs"
                      aria-label="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <select
                  value={chapterSort}
                  onChange={(e) => setChapterSort(e.target.value as 'default' | 'review_first')}
                  className="bg-surface border border-line-soft rounded px-2 py-1 text-xs text-text-strong outline-none"
                  aria-label="Sort chapters"
                >
                  <option value="default">Order: Chunk #</option>
                  <option value="review_first">Order: Review First</option>
                </select>
              </div>

              {/* Review notification pill when showing all and review items exist */}
              {chapterFilter === 'all' && reviewChaptersCount > 0 && (
                <div className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-500">
                  <span>{reviewChaptersCount} chapter(s) need attention</span>
                  <button
                    type="button"
                    onClick={() => setChapterFilter('needs_review')}
                    className="underline font-semibold hover:text-amber-400 ml-1"
                  >
                    Filter list
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {visibleChapters.length === 0 ? (
                <div className="p-4 text-center text-xs text-text-soft space-y-2">
                  {chapterFilter === 'needs_review' ? (
                    <>
                      <div className="text-2xl">🎉</div>
                      <p className="font-semibold text-text-strong">No chapters need manual review!</p>
                      <p>All chapters have passed validation and have recorded audio.</p>
                      <button
                        type="button"
                        onClick={() => setChapterFilter('all')}
                        className="mt-2 text-accent underline font-medium"
                      >
                        Show all {chapters.length} chapters
                      </button>
                    </>
                  ) : (
                    <p>No chapters matched your search query.</p>
                  )}
                </div>
              ) : (
                visibleChapters.map((chap) => {
                  const selected = chap.index === currentChapter?.index;
                  const isFlagged = isChapterNeedingReview(chap);
                  const hasReviewFlag = reviewFlags.some(f => f.chapterIndex === chap.index);
                  const originalIndex = chapters.findIndex(c => c.index === chap.index);

                  return (
                    <div key={chap.index} className="mb-1">
                      <button
                        onClick={() => {
                          if (originalIndex >= 0) setCurrentChapterPosition(originalIndex);
                        }}
                        className={`w-full text-left p-3 rounded text-sm transition-colors border ${
                          selected
                            ? "bg-indigo-500/20 text-brand-400 border-indigo-500/30"
                            : isFlagged
                            ? "bg-amber-500/5 hover:bg-amber-500/10 border-amber-500/30 text-text-strong"
                            : "text-text-soft hover:bg-surface-raised border-transparent"
                        }`}
                      >
                        <div className="flex justify-between items-start gap-1.5 flex-wrap">
                          <div className="font-medium flex items-center gap-1.5 flex-wrap">
                            <span>Chunk {chap.index + 1}</span>
                            {chap.hasRejected && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30" title="Generation rejected. Requires review and re-recording before complete export or upload.">
                                Needs Re-recording
                              </span>
                            )}
                            {chap.isEmptyText && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30" title="Empty text or extraction error">
                                Empty Text
                              </span>
                            )}
                            {hasReviewFlag && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30" title="Flagged during Cloud Drama generation">
                                Review Flag
                              </span>
                            )}
                            {chap.hasAudio === false && !chap.hasRejected && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-500/20 text-zinc-400 border border-zinc-500/30" title="Audio not yet synthesized">
                                Pending Audio
                              </span>
                            )}
                            {(chap.hasRejected || chap.hasFailure || chap.status === 'error' || hasReviewFlag) && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setErrorLogModalChapter({ index: chap.index, title: chap.title });
                                }}
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-600 dark:text-amber-400 border border-amber-500/30 flex items-center gap-1 transition-colors"
                                title="Inspect validation errors and diagnostic log"
                              >
                                <span>📋 Log</span>
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="text-xs mt-1 line-clamp-2 opacity-80">{chap.title}</div>
                      </button>
                    {selected && isMultiVoice && (
                      <div className="ml-3 border-l border-indigo-500/30 py-1 pl-2" aria-label="Speaker segments for selected chapter">
                        {speakerSegments.length > 0 ? speakerSegments.map((segment, segmentIndex) => (
                          <div
                            key={segment.id}
                            id={`drama-speaker-row-${segmentIndex}`}
                            className={`mb-2 grid w-full grid-cols-1 gap-2 rounded border p-2 text-left lg:grid-cols-[2.5rem_minmax(9rem,0.7fr)_minmax(14rem,1.5fr)_auto] lg:items-start ${
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
                                className={`mt-1 w-full rounded border bg-surface px-2 py-1 text-xs font-semibold text-text-strong ${activeSpeakerSegment === segmentIndex ? 'border-accent ring-1 ring-accent' : 'border-line-soft'}`}
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
                                onChange={(event) => setSpeakerTextDrafts((current) => ({
                                  ...current,
                                  [segmentIndex]: event.target.value,
                                }))}
                                onBlur={(event) => updateSpeakerText(segmentIndex, event.target.value)}
                                className="mt-1 min-h-20 w-full rounded border border-line-soft bg-surface p-2 text-xs leading-relaxed text-text-strong"
                                aria-label={`Text for speaker segment ${segmentIndex + 1}`}
                              />
                            </div>
                            <div className="flex gap-1 lg:flex-col">
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
                                className="rounded bg-accent px-2 py-1 text-xs font-semibold text-background disabled:opacity-50"
                                title="Re-record this corrected turn and rebuild the containing audio chunk"
                              >
                                {isRegenerating ? 'Recording…' : 'Re-record'}
                              </button>}
                            </div>
                          </div>
                        )) : (
                          <p className="p-2 text-[11px] text-text-soft">No valid speaker segments were found in this chunk.</p>
                        )}
                        {speakerSegments.length > 0 && (
                          <button
                            type="button"
                            onClick={() => void handleRegenerate()}
                            disabled={!hasEditedText || isRegenerating}
                            className="mt-1 w-full rounded bg-accent px-2 py-1.5 text-xs font-semibold text-background disabled:opacity-50"
                          >
                            {isRegenerating ? 'Re-recording…' : `Apply Changes & Re-record Chunk ${chap.index + 1}`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              }))}
            </div>
          </div>
        )}

        {/* Middle: HTML Viewer with highlighting */}
        {showMiddlePane && (
          <div className="flex-1 overflow-hidden relative flex flex-col border-r border-line-soft h-1/3 md:h-full">
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
          </div>
        )}

        {/* Right side: Editor */}
        {showRightPane && (
          <div className="w-full md:w-1/3 flex flex-col bg-surface-raised border-l border-line-soft h-1/3 md:h-full">
            <div className="p-4 border-b border-line-soft flex justify-between items-center bg-surface shrink-0">
              <h2 className="font-semibold text-text-strong truncate pr-2" title="Edit text (after Smart AI Processing)">
                Edit text (after Smart AI Processing)
              </h2>
            </div>
            <div className="flex-1 p-4 overflow-hidden relative">
              <textarea
                value={chapterText}
                onChange={(e) => {
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
                className="absolute inset-4 w-[calc(100%-2rem)] h-[calc(100%-2rem)] bg-surface border border-line-soft rounded-lg text-text-strong p-4 text-sm font-mono leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                placeholder="Edit the text here..."
              />
            </div>
            <div className="p-4 text-xs text-text-soft bg-surface border-t border-line-soft shrink-0">
              Changes to the text will not be heard until you click "Save to Audiobook" to rebuild the MP3 file.
            </div>
          </div>
        )}
      </div>

      {/* Simple Audio Player for pre-recorded chapter MP3 */}
      <div className="p-4 bg-surface-raised border-t border-line-soft flex items-center justify-center">
        {!isTextLoading && chapterText.length > 0 ? (
          <audio 
            key={`${bookId}-${currentChapter.index}`}
            controls 
            autoPlay
            onTimeUpdate={(event) => setActiveSpeakerSegment(activeSpeakerAtPlaybackTime(
              event.currentTarget.currentTime,
              event.currentTarget.duration,
            ))}
            onEnded={() => setActiveSpeakerSegment(null)}
            className="w-full max-w-2xl"
            src={`/api/audiobook/chapter?bookId=${bookId}&chapterIndex=${currentChapter.index}`}
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
            <button onClick={() => setIsSettingsModalOpen(false)} className="text-text-soft hover:text-text-strong text-2xl px-2 leading-none">&times;</button>
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
            <button onClick={() => setIsQuickAbbrevModalOpen(false)} className="text-text-soft hover:text-text-strong text-xl px-2">&times;</button>
          </div>
          <div className="p-6 flex flex-col gap-4">
            <div>
              <label className="block text-xs font-semibold text-text-strong mb-1">Text in book (e.g. "II")</label>
              <input 
                type="text" 
                value={newAbbrevKey} 
                onChange={(e) => setNewAbbrevKey(e.target.value)}
                className="w-full p-2 border border-line-soft rounded bg-surface-sunken text-text-strong"
                placeholder="Abbreviation or numeral"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-text-strong mb-1">Spoken text (e.g. "point 2")</label>
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
                } catch (e: any) {
                  toast.error(e.message || 'Failed to save abbreviation');
                }
              }}
              className="mt-2 w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-semibold transition-colors disabled:opacity-50"
            >
              Save Abbreviation
            </button>
          </div>
        </div>
      </ModalFrame>

      {/* Multi-Voice Studio Overlay */}
      {showMultiVoiceStudio && isMultiVoice && (
        <MultiVoiceReviewStudio
          bookId={bookId}
          chapterIndex={currentChapter.index}
          initialText={chapterText}
          onClose={() => setShowMultiVoiceStudio(false)}
          onRebuildAllModified={handleRebuildAllModified}
          isRebuildingAll={isRebuildingAll}
          onSaveAndRegenerate={async (newXml) => {
            setChapterText(newXml);
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
              toast.success("Successfully rebuilt background audiobook chapter!");
              setShowMultiVoiceStudio(false);
            } catch (err: any) {
              console.error(err);
              toast.error(err.message || "Error regenerating audio.");
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
          onNextChapter={() => setCurrentChapterPosition(i => Math.min(chapters.length - 1, i + 1))}
          onPrevChapter={() => setCurrentChapterPosition(i => Math.max(0, i - 1))}
          onExit={() => setShowMobilePlayer(false)}
        />
      )}

      <ModalFrame open={showBatchRefineModal} onClose={() => setShowBatchRefineModal(false)} size="xl">
        <div className="bg-surface rounded-xl border border-line-soft overflow-hidden">
          <div className="flex justify-between items-center p-4 border-b border-line-soft bg-surface-raised">
            <h2 className="font-bold text-text-strong">✨ AI Batch Refine</h2>
            <button onClick={() => setShowBatchRefineModal(false)} className="text-text-soft hover:text-text-strong text-2xl px-2 leading-none">&times;</button>
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
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-sm transition-colors flex items-center gap-2"
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
        onReviewChapters={() => {
          setChapterFilter('needs_review');
          setShowLeftPane(true);
        }}
      />

      {errorLogModalChapter && (
        <ChapterErrorLogModal
          open={true}
          onClose={() => setErrorLogModalChapter(null)}
          bookId={bookId}
          chapterIndex={errorLogModalChapter.index}
          chapterTitle={errorLogModalChapter.title}
          onNavigateToChapter={(idx) => {
            const pos = chapters.findIndex((c) => c.index === idx);
            if (pos >= 0) setCurrentChapterPosition(pos);
            setErrorLogModalChapter(null);
          }}
        />
      )}

    </div>
  );
}
