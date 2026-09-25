'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTimeEstimation } from '@/hooks/useTimeEstimation';
import { ProgressPopup } from '@/components/ProgressPopup';
import { ProgressCard } from '@/components/ProgressCard';
import { DownloadIcon, CheckCircleIcon, XCircleIcon, ClockIcon, RefreshIcon, DotsVerticalIcon } from '@/components/icons/Icons';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { useTTS } from '@/contexts/TTSContext';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { MultiVoiceCharacterModal } from '@/components/doclist/MultiVoiceCharacterModal';
import { AudiobookshelfModal } from '@/components/audiobooks/AudiobookshelfModal';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { getTtsLanguageCompatibilityWarnings, resolveTtsLanguage } from '@/lib/shared/language';
import {
  AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS,
  isGeminiRateLimitPause,
} from '@/lib/shared/audiobook-job-status';
import {
  AUDIOBOOK_QUOTA_UPDATED_EVENT,
  formatMonthlyAudiobookQuotaMessage,
  isMonthlyAudiobookQuotaProblem,
} from '@/lib/shared/audiobook-quota';
import {
  MULTI_VOICE_WORKER_MODE,
  DRAMA_GEMINI_TTS_WORKER_MODE,
  getNarratorVoiceId,
  WAITING_FOR_VOICES_STATUS,
} from '@/lib/shared/multi-voice';
import {
  CLOUD_TTS_CHARACTER_VOICE_SET,
  CLOUD_TTS_FEMALE_VOICES,
  CLOUD_TTS_MODEL,
} from '@/lib/shared/google-cloud-tts-voices';
import type { TTSAudiobookChapter, TTSAudiobookFormat } from '@/types/tts';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { AUDIOBOOK_WAITING_FOR_GPU_PHASE } from '@/lib/shared/audiobook-runtime-phase';
import { Button, Card, IconButton, MenuActionItem, MenuItemsSurface, MenuRoot, MenuTransition, MenuTrigger, RangeInput, Select } from '@/components/ui';
import {
  getAudiobookStatus, 
  deleteAudiobookChapter, 
  deleteAudiobook,
  combineAudiobook
} from '@/lib/client/api/audiobooks';
import type { AudiobookGenerationSettings, SmartAudioProfile } from '@/types/client';
interface AudiobookExportModalProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  documentType: 'epub' | 'pdf' | 'html';
  documentId: string;
  onGenerateAudiobook: (
    onProgress: (progress: number) => void,
    signal: AbortSignal,
    onChapterComplete: (chapter: TTSAudiobookChapter) => void,
    settings: AudiobookGenerationSettings
  ) => Promise<string>; // Returns bookId
  onRegenerateChapter?: (
    chapterIndex: number,
    bookId: string,
    settings: AudiobookGenerationSettings,
    signal: AbortSignal,
    confirmScholarAutoScan?: boolean,
  ) => Promise<TTSAudiobookChapter>;
}

export function AudiobookExportModal({
  isOpen,
  setIsOpen,
  documentType,
  documentId,
  onGenerateAudiobook,
  onRegenerateChapter
}: AudiobookExportModalProps) {
  const { isLoading, isDBReady, providerRef, providerType, ttsModel, ttsInstructions, voice: configVoice, voiceSpeed, audioPlayerSpeed, smartAudioProfileId, updateConfigKey } = useConfig();
  const { availableVoices, documentLanguage } = useTTS();
  const { progress, setProgress, estimatedTimeRemaining } = useTimeEstimation();
  const searchParams = useSearchParams();
  const router = useRouter();
  const autoGenerate = searchParams.get('autoGenerate') === 'true';
  const [isGenerating, setIsGenerating] = useState(false);
  const [chapters, setChapters] = useState<TTSAudiobookChapter[]>([]);
  const [bookId, setBookId] = useState<string | null>(null);
  const [isCombining, setIsCombining] = useState(false);
  const [isLoadingExisting, setIsLoadingExisting] = useState(false);
  const [isRefreshingChapters, setIsRefreshingChapters] = useState(false);
  const [currentChapter, setCurrentChapter] = useState<string>('');
  const [format, setFormat] = useState<TTSAudiobookFormat>('m4b');
  const [audiobookVoice, setAudiobookVoice] = useState<string>(configVoice || '');
  const [nativeSpeed, setNativeSpeed] = useState<number>(voiceSpeed);
  const [postSpeed, setPostSpeed] = useState<number>(audioPlayerSpeed);
  const [useSmartAudio, setUseSmartAudio] = useState<boolean>(false);
  const [useScholarDefinitions, setUseScholarDefinitions] = useState<boolean>(true);
  const [smartAudioProfiles, setSmartAudioProfiles] = useState<SmartAudioProfile[]>([]);
  const [selectedSmartAudioProfileId, setSelectedSmartAudioProfileId] = useState<string>(smartAudioProfileId || '');
  const [savedSettings, setSavedSettings] = useState<AudiobookGenerationSettings | null>(null);
  const [regeneratingChapter, setRegeneratingChapter] = useState<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scholarWarningHandledRef = useRef(false);
  const [pendingDeleteChapter, setPendingDeleteChapter] = useState<TTSAudiobookChapter | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showRegenerateHint, setShowRegenerateHint] = useState(false);
  const [showBackgroundWarning, setShowBackgroundWarning] = useState(false);
  const [showScholarScanWarning, setShowScholarScanWarning] = useState(false);
  const [showDramaReplacementWarning, setShowDramaReplacementWarning] = useState(false);
  const [pendingDramaReplacementScholarConfirm, setPendingDramaReplacementScholarConfirm] = useState(false);
  const [showCharacterCasting, setShowCharacterCasting] = useState(false);
  const [castingJobId, setCastingJobId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [startAfterCasting, setStartAfterCasting] = useState(false);
  const [dramaNarratorVoice, setDramaNarratorVoice] = useState<string | null>(null);
  const [isLoadingDramaNarrator, setIsLoadingDramaNarrator] = useState(false);
  const [pendingScholarRegeneration, setPendingScholarRegeneration] = useState<TTSAudiobookChapter | null>(null);
  const [pendingCloseAction, setPendingCloseAction] = useState<'close_modal' | 'navigate' | null>(null);
  const [showAudiobookshelfModal, setShowAudiobookshelfModal] = useState(false);

  const formatSpeed = useCallback((speed: number) => {
    return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
  }, []);
  const providerModelPolicy = useMemo(
    () => resolveTtsProviderModelPolicy({ providerRef, providerType, model: ttsModel }),
    [providerRef, providerType, ttsModel],
  );
  const nativeSpeedSupported = providerModelPolicy.supportsNativeModelSpeed;
  const effectiveNativeSpeed = nativeSpeedSupported ? nativeSpeed : 1;
  const hasExistingAudiobook = Boolean(bookId) || chapters.length > 0;
  const isLegacyAudiobookMissingSettings = hasExistingAudiobook && savedSettings === null;
  const selectedSmartAudioProfile = useMemo(
    () => smartAudioProfiles.find((profile) => profile.id === selectedSmartAudioProfileId) || smartAudioProfiles[0] || null,
    [smartAudioProfiles, selectedSmartAudioProfileId],
  );
  const isDramaProfile = useSmartAudio
    && (selectedSmartAudioProfile?.workerMode === MULTI_VOICE_WORKER_MODE
      || selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE);

  const applyDramaNarratorVoice = useCallback((value: unknown): string | null => {
    const isCloudDrama = selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE;
    const voiceId = getNarratorVoiceId(value, isCloudDrama ? { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET } : {});
    setDramaNarratorVoice(voiceId);
    if (voiceId && !savedSettings && !hasExistingAudiobook) setAudiobookVoice(voiceId);
    return voiceId;
  }, [hasExistingAudiobook, savedSettings, selectedSmartAudioProfile?.workerMode]);

  useEffect(() => {
    if (!isOpen || !isDramaProfile || !selectedSmartAudioProfileId) {
      setDramaNarratorVoice(null);
      setIsLoadingDramaNarrator(false);
      return;
    }
    const controller = new AbortController();
    setIsLoadingDramaNarrator(true);
    void fetch(`/api/audiobook/characters/scan?documentId=${encodeURIComponent(documentId)}&profileId=${encodeURIComponent(selectedSmartAudioProfileId)}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('Failed to load the Audio Drama narrator voice.');
      const body = await response.json().catch(() => ({}));
      applyDramaNarratorVoice(body.characterMap);
    }).catch((error) => {
      if ((error as Error)?.name !== 'AbortError') setDramaNarratorVoice(null);
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoadingDramaNarrator(false);
    });
    return () => controller.abort();
  }, [applyDramaNarratorVoice, documentId, isDramaProfile, isOpen, selectedSmartAudioProfileId]);

  useEffect(() => {
    const controller = new AbortController();
    const loadProfiles = async () => {
      try {
        const response = await fetch('/api/tts-settings', { signal: controller.signal });
        const data = await response.json();
        const profiles = Array.isArray(data.smartAudioProfiles) ? data.smartAudioProfiles : [];
        setSmartAudioProfiles(profiles);

        const preferredProfileId = typeof data.selectedSmartAudioProfileId === 'string' && data.selectedSmartAudioProfileId
          ? data.selectedSmartAudioProfileId
          : smartAudioProfileId;
        const nextProfileId = profiles.some((profile: SmartAudioProfile) => profile.id === preferredProfileId)
          ? preferredProfileId
          : profiles[0]?.id || '';
        setSelectedSmartAudioProfileId(nextProfileId);
        const profile = profiles.find((p: SmartAudioProfile) => p.id === nextProfileId);
        if (profile?.workerMode === MULTI_VOICE_WORKER_MODE || profile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
          setUseSmartAudio(true);
        }
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return;
        console.warn('Failed to load smart audio profiles:', error);
      }
    };

    void loadProfiles();

    const handleUpdate = () => {
      void loadProfiles();
    };
    window.addEventListener('smart-audio-profiles-updated', handleUpdate);

    return () => {
      controller.abort();
      window.removeEventListener('smart-audio-profiles-updated', handleUpdate);
    };
  }, [smartAudioProfileId]);

  useEffect(() => {
    // For new audiobooks (no saved settings/chapters), keep generation defaults aligned
    // with the current playback controls so users don't need a route remount.
    if (!isOpen) return;
    if (savedSettings) return;
    if (hasExistingAudiobook) return;
    if (isDramaProfile) return;

    setNativeSpeed(voiceSpeed);
    setPostSpeed(audioPlayerSpeed);
    setAudiobookVoice(configVoice || availableVoices[0] || '');
  }, [
    isOpen,
    savedSettings,
    hasExistingAudiobook,
    voiceSpeed,
    audioPlayerSpeed,
    configVoice,
    availableVoices,
    isDramaProfile,
  ]);

  useEffect(() => {
    if (savedSettings) return;
    if (audiobookVoice) return;
    if (availableVoices.length > 0) {
      setAudiobookVoice(availableVoices[0] || '');
    }
  }, [savedSettings, audiobookVoice, availableVoices]);

  const isCloudDrama = selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE;
  const effectiveSettings: AudiobookGenerationSettings | null = useMemo(() => {
    if (savedSettings) return savedSettings;
    const dramaVoice = dramaNarratorVoice || (isCloudDrama ? (CLOUD_TTS_FEMALE_VOICES[0] || 'en-US-Journey-F') : null);
    const nextVoice = (isDramaProfile ? dramaVoice : null) || audiobookVoice || configVoice || availableVoices[0] || (isCloudDrama ? 'en-US-Journey-F' : '');
    if (!nextVoice) return null;
    return {
      providerRef: isCloudDrama ? 'google-cloud' : providerRef,
      providerType,
      ttsModel: isCloudDrama ? CLOUD_TTS_MODEL : ttsModel,
      voice: nextVoice,
      nativeSpeed: effectiveNativeSpeed,
      postSpeed,
      format,
      useSmartAudio,
      smartAudioProfileId: selectedSmartAudioProfileId || smartAudioProfileId || undefined,
      scholarIncludeDefinitions: useScholarDefinitions,
      ttsInstructions: providerModelPolicy.supportsInstructions ? ttsInstructions : undefined,
      language: isCloudDrama && selectedSmartAudioProfile?.dramaGeminiTtsSettings?.languageCode
        ? selectedSmartAudioProfile.dramaGeminiTtsSettings.languageCode
        : resolveTtsLanguage({
            configuredLanguage: documentLanguage,
            voice: nextVoice,
          }),
    };
  }, [
    savedSettings,
    isDramaProfile,
    isCloudDrama,
    dramaNarratorVoice,
    audiobookVoice,
    configVoice,
    availableVoices,
    providerRef,
    providerType,
    ttsModel,
    ttsInstructions,
    effectiveNativeSpeed,
    postSpeed,
    format,
    providerModelPolicy.supportsInstructions,
    documentLanguage,
    useSmartAudio,
    useScholarDefinitions,
    selectedSmartAudioProfileId,
    smartAudioProfileId,
    selectedSmartAudioProfile?.dramaGeminiTtsSettings?.languageCode,
  ]);
  const languageWarnings = useMemo(() => getTtsLanguageCompatibilityWarnings({
    model: effectiveSettings?.ttsModel,
    voice: effectiveSettings?.voice,
    documentLanguage: effectiveSettings?.language,
  }), [effectiveSettings]);

  const fetchExistingChapters = useCallback(async (soft: boolean = false) => {
    if (soft) {
      setIsRefreshingChapters(true);
    } else {
      setIsLoadingExisting(true);
    }

    let serverIsGenerating = false;
    // Check server queue status FIRST to prevent race conditions where a job completes
    // between fetching chapters and checking the queue, which would cause us to miss the final chapters.
    try {
      const qRes = await fetch('/api/audiobooks/queue');
      if (qRes.ok) {
        const qData = await qRes.json();
        const activeJob = qData.jobs?.find((j: {
          id: string;
          documentId: string;
          status: string;
          progress?: number;
          error?: string | null;
          phase?: string | null;
          gpuQueueState?: string | null;
        }) => j.documentId === documentId && (
          j.status === 'queued'
          || j.status === 'running'
          || j.status === AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS
          || j.status === 'waiting_for_pdf'
          || j.status === WAITING_FOR_VOICES_STATUS
        ));
        if (activeJob) {
          setActiveJobId(activeJob.id);
          if (activeJob.status === WAITING_FOR_VOICES_STATUS) {
            setCastingJobId(activeJob.id);
            setStartAfterCasting(false);
            setShowCharacterCasting(true);
            setIsGenerating(false);
            setCurrentChapter('Waiting for character voice review…');
          } else {
            serverIsGenerating = true;
            setIsGenerating(true);
            if (activeJob.progress !== undefined) setProgress(activeJob.progress);
            if (activeJob.phase === AUDIOBOOK_WAITING_FOR_GPU_PHASE) {
              setCurrentChapter('Waiting for the shared GPU. Kokoro has priority and will start automatically when the shared GPU is ready.');
            } else if (activeJob.status === 'queued' && isGeminiRateLimitPause(activeJob.error)) {
              setCurrentChapter(activeJob.error);
            } else if (activeJob.status === 'queued') setCurrentChapter('Queued on server...');
            else if (activeJob.status === AUDIOBOOK_ADMIN_PAUSE_REQUESTED_STATUS) setCurrentChapter('Pause requested. Waiting for the current step to finish...');
            else if (activeJob.status === 'waiting_for_pdf') setCurrentChapter('Waiting for PDF parsing...');
            else setCurrentChapter('Generating on server...');
          }
        } else {
          setActiveJobId(null);
        }
      }
    } catch {
      // Ignored
    }

    try {
      const data = await getAudiobookStatus(documentId);
      console.log('DEBUG_FETCH_CHAPTERS_RESULT:', data);
      if (data.exists) {
        setChapters(data.chapters || []);
        setBookId(data.bookId);
        if (data.chapters[0]?.format) {
          const detectedFormat = data.chapters[0].format as TTSAudiobookFormat;
          setFormat(detectedFormat);
        }
        if (data.settings) {
          setSavedSettings(data.settings);
          setAudiobookVoice(data.settings.voice);
          setNativeSpeed(data.settings.nativeSpeed);
          setPostSpeed(data.settings.postSpeed);
          setFormat(data.settings.format);
          if (data.settings.useSmartAudio !== undefined) {
            setUseSmartAudio(Boolean(data.settings.useSmartAudio));
          }
        } else {
          setSavedSettings(null);
        }
        if (data.hasComplete) {
          setProgress(100);
        }
      } else {
        // If nothing exists, clear chapters/bookId to reflect current state
        setChapters([]);
        setBookId(null);
        setSavedSettings(null);
      }
    } catch (error) {
      console.error('Error fetching existing chapters:', error);
    } finally {
      if (soft) {
        setIsRefreshingChapters(false);
      } else {
        setIsLoadingExisting(false);
      }
    }

    if (!serverIsGenerating) {
      // If no active job on the server, ensure we are not in a generating state.
      setIsGenerating(false);
    }
  }, [documentId, setProgress]);

  // Keep latest fetchExistingChapters function to avoid resetting interval on every progress/state update
  const fetchExistingChaptersRef = useRef(fetchExistingChapters);
  useEffect(() => {
    fetchExistingChaptersRef.current = fetchExistingChapters;
  }, [fetchExistingChapters]);

  // Fetch existing chapters when modal opens
  useEffect(() => {
    if (isOpen && documentId && !isGenerating) {
      fetchExistingChapters();
    }
  }, [isOpen, documentId, isGenerating, fetchExistingChapters]);

  // Poll for status updates
  useEffect(() => {
    if (!isOpen || !isGenerating) return;

    const interval = setInterval(() => {
      fetchExistingChaptersRef.current(true);
    }, 3000);
    return () => clearInterval(interval);
  }, [isOpen, documentId, isGenerating]);

  const handleChapterComplete = useCallback((chapter: TTSAudiobookChapter) => {
    setChapters(prev => {
      const existing = prev.find(c => c.index === chapter.index);
      if (existing) {
        return prev.map(c => c.index === chapter.index ? chapter : c);
      }
      return [...prev, chapter].sort((a, b) => a.index - b.index);
    });
    setCurrentChapter(chapter.title);
  }, []);

  const handleStartGeneration = useCallback(async (
    confirmScholarAutoScan = false,
    narratorVoiceOverride?: string | null,
    confirmReplaceExisting = false,
  ) => {
    if (!effectiveSettings) {
      setErrorMessage('No voice selected; please choose a voice before generating.');
      return;
    }
    setIsGenerating(true);
    setProgress(0);
    setCurrentChapter('');
    // Don't clear chapters if resuming
    if (!bookId) {
      setChapters([]);
      setBookId(null);
    }
    abortControllerRef.current = new AbortController();

    try {
      const settingsWithToggle = {
        ...effectiveSettings,
        ...(narratorVoiceOverride ? { voice: narratorVoiceOverride } : {}),
        useSmartAudio,
      };

      // Queue it on the server
      const res = await fetch('/api/audiobooks/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId,
          settings: settingsWithToggle,
          confirmScholarAutoScan,
          confirmReplaceExisting,
        })
      });
      const responseBody = await res.json().catch(() => null);
      if (res.status === 409 && responseBody?.code === 'SCHOLAR_SCAN_REQUIRED') {
        setIsGenerating(false);
        scholarWarningHandledRef.current = true;
        setShowScholarScanWarning(true);
        return;
      }
      if (res.status === 409 && responseBody?.code === 'CHARACTER_CAST_REQUIRED') {
        setIsGenerating(false);
        setCastingJobId(null);
        setStartAfterCasting(true);
        setShowCharacterCasting(true);
        return;
      }
      if (res.status === 409 && responseBody?.code === 'AUDIOBOOK_REPLACEMENT_REQUIRED') {
        setIsGenerating(false);
        setPendingDramaReplacementScholarConfirm(confirmScholarAutoScan);
        setShowDramaReplacementWarning(true);
        return;
      }
      if (res.status === 429 && isMonthlyAudiobookQuotaProblem(responseBody)) {
        setIsGenerating(false);
        setErrorMessage(formatMonthlyAudiobookQuotaMessage(responseBody));
        return;
      }
      if (!res.ok) throw new Error(responseBody?.error || 'Failed to queue audiobook on server');
      window.dispatchEvent(new Event(AUDIOBOOK_QUOTA_UPDATED_EVENT));
      
      // Start polling
      await fetchExistingChapters();

      // Check if there is a batch queue in localStorage
      const queueRaw = localStorage.getItem('batchAudiobookQueue');
      if (queueRaw) {
        try {
          const batchData = JSON.parse(queueRaw);
          if (batchData && batchData.queue && batchData.queue.length > 0) {
            const nextDoc = batchData.queue[0];
            const remainingQueue = batchData.queue.slice(1);
            localStorage.setItem('batchAudiobookQueue', JSON.stringify({
              queue: remainingQueue,
              settings: batchData.settings
            }));
            router.push(`/${nextDoc.type}/${nextDoc.id}?autoGenerate=true`);
            return; // skip cleanup to avoid unmount issues during navigation
          } else {
            // Queue is empty, clear it and go back to app
            localStorage.removeItem('batchAudiobookQueue');
            router.push('/app');
            return;
          }
        } catch (e) {
          console.error('Failed to parse batch queue', e);
        }
      }

    } catch (error) {
      console.error('Error generating audiobook:', error);
      setIsGenerating(false);
      if (error instanceof Error && error.message.includes('cancelled')) {
        console.log('Audiobook generation cancelled gracefully');
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to generate audiobook. Please try again.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onGenerateAudiobook, handleChapterComplete, setProgress, bookId, documentId, fetchExistingChapters, effectiveSettings, useSmartAudio, router]);

  // Effect to auto-start generation if URL has autoGenerate=true
  useEffect(() => {
    if (
      autoGenerate
      && !scholarWarningHandledRef.current
      && !showCharacterCasting
      && !isGenerating
      && !isLoadingExisting
      && effectiveSettings
      && bookId === null
    ) {
      // Check batch queue to apply settings automatically
      const queueRaw = localStorage.getItem('batchAudiobookQueue');
      if (queueRaw) {
        try {
          const batchData = JSON.parse(queueRaw);
          if (batchData.settings) {
            setAudiobookVoice(batchData.settings.voice);
            setFormat(batchData.settings.format);
            setNativeSpeed(batchData.settings.nativeSpeed);
            setPostSpeed(batchData.settings.postSpeed);
          }
        } catch (e) {
          console.error(e);
        }
      }
      // Start generating after a tiny delay so state settles
      const timeout = setTimeout(() => {
        handleStartGeneration();
      }, 500);
      return () => clearTimeout(timeout);
    }
  }, [autoGenerate, isGenerating, isLoadingExisting, effectiveSettings, bookId, handleStartGeneration, showCharacterCasting]);

  const handleCancel = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    if (activeJobId) {
      try {
        await fetch(`/api/audiobooks/queue?id=${activeJobId}`, { method: 'DELETE' });
        // Update local state to reflect cancellation immediately
        setIsGenerating(false);
        setActiveJobId(null);
      } catch (error) {
        console.error('Failed to cancel background audiobook job', error);
      }
    } else {
      setIsGenerating(false);
    }
  }, [activeJobId]);

  const handleSmartAudioProfileChange = useCallback((profileId: string) => {
    setSelectedSmartAudioProfileId(profileId);
    void updateConfigKey('smartAudioProfileId', profileId);
    const profile = smartAudioProfiles.find(p => p.id === profileId);
    if (profile?.workerMode === MULTI_VOICE_WORKER_MODE || profile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
      setUseSmartAudio(true);
    }
  }, [smartAudioProfiles, updateConfigKey]);

  // Cancel in-flight conversion ONLY if the page is literally being closed or refreshed.
  // We DO NOT cancel on unmount, so that generation continues in the background if the user navigates within the SPA.
  useEffect(() => {
    const onPageHide = () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      // Removed unmount abort to allow background generation
    };
  }, []);

  const handleRegenerateChapter = useCallback(async (
    chapter: TTSAudiobookChapter,
    confirmScholarAutoScan = false,
  ) => {
    if (!onRegenerateChapter || !bookId) return;
    if (!effectiveSettings) {
      setErrorMessage('No voice selected; please choose a voice before generating.');
      return;
    }

    if (!showRegenerateHint) {
      setShowRegenerateHint(true);
    }

    setRegeneratingChapter(chapter.index);
    setCurrentChapter(`Regenerating: ${chapter.title}`);
    abortControllerRef.current = new AbortController();

    try {
      // Update chapter status to generating
      setChapters(prev => {
        const exists = prev.some(c => c.index === chapter.index);
        if (exists) {
          return prev.map(c =>
            c.index === chapter.index
              ? { ...c, status: 'generating' as const }
              : c
          );
        }
        // If it's a missing placeholder, add it as generating
        return [...prev, { ...chapter, status: 'generating' as const }].sort((a, b) => a.index - b.index);
      });

      const regeneratedChapter = await onRegenerateChapter(
        chapter.index,
        bookId,
        effectiveSettings,
        abortControllerRef.current.signal,
        confirmScholarAutoScan,
      );

      // Update chapter with new data
      setChapters(prev => prev.map(c =>
        c.index === chapter.index
          ? regeneratedChapter
          : c
      ));

    } catch (error) {
      console.error('Error regenerating chapter:', error);
      if (
        error instanceof Error
        && (error as Error & { code?: string }).code === 'SCHOLAR_SCAN_REQUIRED'
      ) {
        setPendingScholarRegeneration(chapter);
        setChapters(prev => prev.map(c =>
          c.index === chapter.index
            ? { ...c, status: chapter.status }
            : c
        ));
      } else if (error instanceof Error && error.message.includes('cancelled')) {
        console.log('Chapter regeneration cancelled');
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to regenerate chapter. Please try again.');
        // Mark as error
        setChapters(prev => prev.map(c =>
          c.index === chapter.index
            ? { ...c, status: 'error' as const }
            : c
        ));
      }
    } finally {
      setRegeneratingChapter(null);
      setCurrentChapter('');
      setProgress(0);
      abortControllerRef.current = null;
      // Refresh chapters to get updated data (soft refresh list only)
      await fetchExistingChapters(true);
    }
  }, [onRegenerateChapter, bookId, setProgress, fetchExistingChapters, showRegenerateHint, effectiveSettings]);

  const performDeleteChapter = useCallback(async () => {
    if (!bookId || !pendingDeleteChapter) return;
    try {
      await deleteAudiobookChapter(bookId, pendingDeleteChapter.index);
      setChapters(prev => prev.filter(c => c.index !== pendingDeleteChapter.index));
      await fetchExistingChapters(true);
    } catch (error) {
      console.error('Error deleting chapter:', error);
      setErrorMessage('Failed to delete chapter. Please try again.');
    } finally {
      setPendingDeleteChapter(null);
    }
  }, [bookId, pendingDeleteChapter, fetchExistingChapters]);

  const performResetAll = useCallback(async () => {
    const targetBookId = bookId || documentId;
    if (!targetBookId) return;
    try {
      await deleteAudiobook(targetBookId);
      setChapters([]);
      setBookId(null);
      setProgress(0);
    } catch (error) {
      console.error('Error resetting audiobook chapters:', error);
      setErrorMessage('Failed to reset chapters. Please try again.');
    } finally {
      setShowResetConfirm(false);
      await fetchExistingChapters(true);
    }
  }, [bookId, documentId, setProgress, fetchExistingChapters]);

  const handleDownloadChapter = useCallback(async (chapter: TTSAudiobookChapter) => {
    if (!bookId) return;

    try {
      const ext = chapter.format || 'm4b';
      const url = `/api/audiobook/chapter?bookId=${bookId}&chapterIndex=${chapter.index}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${chapter.title}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error downloading chapter:', error);
      setErrorMessage('Failed to download chapter. Please try again.');
    }
  }, [bookId]);

  const handleDownloadComplete = useCallback(async () => {
    if (!bookId) return;

    setIsCombining(true);
    try {
      const { default: toast } = await import('react-hot-toast');
      const toastId = toast.loading('Preparing audiobook...');
      const { downloadAudiobookWithBackgroundPolling } = await import('@/lib/client/api/audiobooks');
      await downloadAudiobookWithBackgroundPolling(bookId, format, toast, toastId);
      
      // Delay disabling the loading state so the browser has time to start the download
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error('Error downloading complete audiobook:', error);
      if (error instanceof Error && (error as Error & { code?: string }).code === 'AUDIOBOOK_CHAPTER_REVIEW_REQUIRED') {
        setIsOpen(false);
        router.push(`/listen/${encodeURIComponent(bookId)}?reviewPronunciation=true`);
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : 'Failed to download audiobook. Please try again.');
    } finally {
      setIsCombining(false);
    }
  }, [bookId, format, router, setIsOpen]);


  const formatDuration = (seconds?: number) => {
    if (!seconds) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Compute display list including gaps before the highest existing index
  const maxIndex = chapters.length > 0 ? Math.max(...chapters.map(c => c.index)) : -1;
  const displayChapters: TTSAudiobookChapter[] =
    maxIndex >= 0
      ? Array.from({ length: maxIndex + 1 }, (_, i) => {
        const existing = chapters.find(c => c.index === i);
        if (existing) return existing;
        return {
          index: i,
          title: documentType === 'pdf' ? `Page ${i + 1}` : `Chapter ${i + 1}`,
          status: 'pending',
          bookId: bookId || undefined,
          format
        };
      })
      : [];

  // Determine if we should show the Resume and Reset buttons
  const hasAnyChapters = chapters.length > 0;
  const showResumeButton = !isGenerating && !regeneratingChapter && hasAnyChapters;
  const showResetButton = !isGenerating && !regeneratingChapter && hasAnyChapters;
  const settingsLocked = savedSettings !== null;
  const canGenerate = effectiveSettings !== null;

  // Do not render until storage/config is initialized
  if (isLoading || !isDBReady) {
    return null;
  }

  return (
    <>
      <ProgressPopup
        isOpen={isGenerating && !isOpen}
        progress={progress}
        estimatedTimeRemaining={estimatedTimeRemaining || undefined}
        onCancel={handleCancel}
        cancelText="Cancel"
        operationType="audiobook"
        onClick={() => setIsOpen(true)}
        currentChapter={currentChapter}
        totalChapters={documentType === 'epub' ? undefined : undefined}
        completedChapters={chapters.filter(c => c.status === 'completed').length}
      />

      <ReaderSidebarShell
        isOpen={isOpen}
        onClose={() => {
          if (isGenerating) {
            setPendingCloseAction('close_modal');
            setShowBackgroundWarning(true);
          } else {
            setIsOpen(false);
          }
        }}
        ariaLabel="Export audiobook"
        title="Export Audiobook"
        subtitle="Only leaving the document cancels generation."
      >
                {isLoadingExisting ? (
                  <AudiobookSettingsSkeleton />
                ) : (
                  <>
			                      <div className="space-y-4">
			                        {!isGenerating && (
			                          <div className="w-full rounded-lg border border-line bg-background">
			                            {/* Header */}
			                            <div className="flex items-center justify-between px-4 py-3 border-b border-line-soft bg-surface rounded-t-xl">
			                              <h4 className="text-sm font-medium text-foreground tracking-tight">Generation settings</h4>
			                              {settingsLocked && (
			                                <span className="inline-flex items-center gap-1 rounded-md bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-soft uppercase tracking-wider">
			                                  <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M8 1a3.5 3.5 0 0 0-3.5 3.5V7A1.5 1.5 0 0 0 3 8.5v5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 11.5 7V4.5A3.5 3.5 0 0 0 8 1Zm2 6V4.5a2 2 0 1 0-4 0V7h4Z" clipRule="evenodd" /></svg>
			                                  Locked
			                                </span>
			                              )}
			                            </div>

			                            <div className="p-4">
			                              {isLegacyAudiobookMissingSettings && (
			                                <div className="mb-4 rounded-lg border border-accent-line bg-accent-wash p-3 text-xs text-foreground">
			                                  <div className="font-medium">Saved generation settings not found</div>
			                                  <div className="mt-1 text-soft">
			                                    This audiobook was likely created before v1 metadata was introduced, so OpenReader can&apos;t know
			                                    which voice/speeds/format were used. Consider resetting this audiobook to regenerate it with
			                                    v1 metadata (so settings are saved for resumes across devices).
			                                  </div>
			                                </div>
			                              )}

			                              {settingsLocked && savedSettings ? (
			                                <div className="space-y-3">
			                                  <div className="grid grid-cols-2 gap-3">
			                                    <Card className="p-3">
			                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Voice</div>
			                                      <div className="text-sm font-medium text-foreground truncate">{savedSettings.voice}</div>
			                                    </Card>
			                                    <Card className="p-3">
			                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Format</div>
			                                      <div className="text-sm font-medium text-foreground">{savedSettings.format.toUpperCase()}</div>
			                                    </Card>
			                                  </div>
                                  <div className="grid grid-cols-2 gap-3">
                                    <Card className="p-3">
                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Native speed</div>
                                      <div className="text-sm font-medium text-foreground">
                                        {resolveTtsProviderModelPolicy({
                                          providerRef: savedSettings.providerRef,
                                          providerType: savedSettings.providerType,
                                          model: savedSettings.ttsModel,
                                        }).supportsNativeModelSpeed
                                          ? `${formatSpeed(savedSettings.nativeSpeed)}x`
                                          : 'Not supported'}
                                      </div>
                                    </Card>
			                                    <Card className="p-3">
			                                      <div className="text-[11px] uppercase tracking-wider text-soft mb-1">Post speed</div>
			                                      <div className="text-sm font-medium text-foreground">{formatSpeed(savedSettings.postSpeed)}x</div>
			                                    </Card>
			                                  </div>
			                                  <p className="text-xs text-soft">
			                                    Reset the audiobook to change generation settings.
			                                  </p>
			                                </div>
			                              ) : (
			                                <div className="space-y-4">
			                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
			                                    <div className="space-y-1.5">
			                                      <label className="text-[11px] uppercase tracking-wider font-medium text-soft">
			                                        {isDramaProfile ? 'Narrator Voice' : 'Voice'}
			                                      </label>
			                                      {isDramaProfile ? (
			                                        <div className="space-y-1.5">
			                                          <div className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-foreground">
			                                            {isLoadingDramaNarrator
			                                              ? 'Loading narrator voice…'
			                                              : dramaNarratorVoice || 'Not assigned yet'}
			                                          </div>
			                                          <button
			                                            type="button"
			                                            onClick={() => {
			                                              setStartAfterCasting(false);
			                                              setShowCharacterCasting(true);
			                                            }}
			                                            className="text-xs font-medium text-accent hover:underline"
			                                          >
			                                            {dramaNarratorVoice ? 'Review character voices' : 'Assign narrator and character voices'}
			                                          </button>
			                                        </div>
			                                      ) : (
			                                        <VoicesControlBase
			                                          availableVoices={availableVoices}
			                                          voice={audiobookVoice}
			                                          onChangeVoice={(newVoice) => {
			                                            setAudiobookVoice(newVoice);
			                                            updateConfigKey('voice', newVoice);
			                                          }}
			                                          providerType={providerType}
			                                          ttsModel={ttsModel}
			                                          dropdownDirection="down"
			                                          variant="field"
			                                        />
			                                      )}
			                                    </div>

			                                    <div className="space-y-1.5">
			                                      <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Format</label>
			                                      {chapters.length === 0 ? (
			                                        <Select
			                                          value={format}
			                                          onChange={(newFormat) => setFormat(newFormat)}
			                                          options={['m4b', 'mp3'] as const}
			                                          disabled={chapters.length > 0 || settingsLocked}
			                                          renderValue={(option) => (
			                                            <span className="text-sm font-medium">{option.toUpperCase()}</span>
			                                          )}
			                                          renderOption={(option, { selected }) => (
			                                            <span className={`block truncate text-sm ${selected ? 'font-medium' : 'font-normal'}`}>
			                                              {option.toUpperCase()}
			                                            </span>
			                                          )}
			                                          buttonClassName="bg-surface"
			                                          chevronClassName="h-4 w-4 text-soft"
			                                          optionInset="none"
			                                          optionItemClassName="py-2"
			                                          showCheckmark={false}
			                                        />
			                                      ) : (
			                                        <div className="text-sm font-medium text-foreground py-1.5 pl-3">{format.toUpperCase()}</div>
			                                      )}
			                                    </div>
			                                  </div>
                                  {languageWarnings.map((warning) => (
                                    <p key={warning} className="text-xs text-warning">
                                      {warning}
                                    </p>
                                  ))}

                                  {/* Speed controls */}
                                  <Card className="p-3 space-y-3">
                                    {!nativeSpeedSupported && (
                                      <div className="rounded-md border border-line bg-background px-2 py-1.5 text-[11px] text-soft">
                                        Native model speed is not available for this model.
                                      </div>
                                    )}

                                    {nativeSpeedSupported && (
                                      <>
                                        <div className="space-y-2">
                                          <div className="flex items-center justify-between">
                                            <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Native model speed</label>
                                            <span className="text-xs font-medium text-accent tabular-nums">{formatSpeed(nativeSpeed)}x</span>
                                          </div>
                                          <RangeInput
                                            min="0.5"
                                            max="3"
                                            step="0.1"
                                            value={nativeSpeed}
                                            onChange={(e) => setNativeSpeed(parseFloat(e.target.value))}
                                          />
                                          <div className="flex justify-between text-[10px] text-soft">
                                            <span>0.5x</span>
                                            <span>3x</span>
                                          </div>
                                        </div>

                                        <div className="border-t border-line-soft" />
                                      </>
                                    )}

			                                    <div className="space-y-2">
			                                      <div className="flex items-center justify-between">
			                                        <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Post-generation speed</label>
			                                        <span className="text-xs font-medium text-accent tabular-nums">{formatSpeed(postSpeed)}x</span>
			                                      </div>
			                                      <RangeInput
			                                        min="0.5"
			                                        max="3"
			                                        step="0.1"
			                                        value={postSpeed}
			                                        onChange={(e) => setPostSpeed(parseFloat(e.target.value))}
			                                      />
			                                      <div className="flex justify-between text-[10px] text-soft">
			                                        <span>0.5x</span>
			                                        <span>3x</span>
			                                      </div>
			                                    </div>
			                                  </Card>
			                                </div>
			                              )}

                                    {/* 🧠 Smart AI Toggle */}
                                        <Card className="p-3">
                                          <label className="flex items-center justify-between cursor-pointer">
                                            <div className="space-y-0.5 pr-4">
                                              <span className="text-sm font-medium text-foreground">Smart AI Formatting</span>
                                              <p className="text-xs text-soft">Use Gemini to process footnotes, apply phonetics, and fix layout artifacts before TTS generation.</p>
                                            </div>
                                            <div className="relative inline-flex items-center shrink-0">
                                              <input
                                                type="checkbox"
                                                className="peer sr-only"
                                                checked={useSmartAudio}
                                                onChange={(e) => {
                                                  if (e.target.checked && smartAudioProfiles.length === 0) {
                                                    window.alert('No Smart AI profile exists. Please create one to use this feature.');
                                                    window.dispatchEvent(new CustomEvent('open-smart-ai-profiles'));
                                                    setUseSmartAudio(false);
                                                  } else if (e.target.checked) {
                                                    const currentProfile = smartAudioProfiles.find(p => p.id === selectedSmartAudioProfileId) || smartAudioProfiles[0];
                                                    if (!currentProfile?.geminiApiKeyConfigured) {
                                                      window.alert('The selected Smart AI profile does not have a Gemini API key configured. Please add one in the Smart AI profile settings.');
                                                      window.dispatchEvent(new CustomEvent('open-smart-ai-profiles'));
                                                      setUseSmartAudio(false);
                                                    } else {
                                                      setUseSmartAudio(true);
                                                    }
                                                  } else {
                                                    setUseSmartAudio(false);
                                                  }
                                                }}
                                                disabled={settingsLocked}
                                              />
                                              <div className="h-6 w-11 rounded-full bg-surface-sunken border border-line peer-checked:bg-accent peer-checked:border-accent after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-full peer-disabled:opacity-50"></div>
                                            </div>
                                          </label>
                                        </Card>

                                        {useSmartAudio && (
                                          <Card className="p-3">
                                            <div className="space-y-2">
                                              <label className="block text-sm font-medium text-foreground">Smart AI Profile</label>
                                              <select
                                                className="w-full rounded-md border border-line bg-background px-3 py-2 text-sm text-foreground"
                                                value={selectedSmartAudioProfileId}
                                                onChange={(e) => {
                                                  const newProfileId = e.target.value;
                                                  const newProfile = smartAudioProfiles.find(p => p.id === newProfileId);
                                                  if (!newProfile?.geminiApiKeyConfigured) {
                                                    window.alert('This Smart AI profile does not have a Gemini API key configured. Please add one in the Smart AI profile settings.');
                                                    window.dispatchEvent(new CustomEvent('open-smart-ai-profiles'));
                                                    setUseSmartAudio(false);
                                                  }
                                                  handleSmartAudioProfileChange(newProfileId);
                                                }}
                                              >
                                                {smartAudioProfiles.map((profile) => (
                                                  <option key={profile.id} value={profile.id}>
                                                    {profile.name}
                                                  </option>
                                                ))}
                                                {smartAudioProfiles.length === 0 && (
                                                  <option value="">No smart AI profiles found</option>
                                                )}
                                              </select>
                                              {selectedSmartAudioProfile && (
                                                <div className="space-y-0.5 text-xs text-soft">
                                                  <p>Pronunciation: {selectedSmartAudioProfile.pronunciationAiModel || selectedSmartAudioProfile.aiModel}</p>
                                                  <p>Cleanup: {[selectedSmartAudioProfile.aiModel, ...(selectedSmartAudioProfile.aiModelFallbacks || [])].join(' → ')} · {Object.keys(selectedSmartAudioProfile.abbreviations || {}).length} abbreviations · {Object.keys(selectedSmartAudioProfile.pronunciations || {}).length} pronunciations</p>
                                                </div>
                                              )}
                                            </div>
                                          </Card>
                                        )}

                                        {/* 📖 Scholar Definitions Toggle — only for scholar-like profiles */}
                                        {useSmartAudio && (
                                          selectedSmartAudioProfile?.workerMode === 'scholar' ||
                                          selectedSmartAudioProfile?.workerMode === 'bibliography-catcher'
                                        ) && (
                                          <div className="rounded-lg border border-accent bg-accent-wash p-3">
                                            <label className="flex items-center justify-between cursor-pointer">
                                              <div className="space-y-0.5 pr-4">
                                                <span className="text-sm font-medium text-foreground">Inject English Definitions</span>
                                                <p className="text-xs text-soft">When enabled, cached contextual English definitions are inserted inline next to foreign-language terms before the Gemini cleanup pass. Disable to get IPA pronunciation markup only.</p>
                                              </div>
                                              <div className="relative inline-flex items-center shrink-0">
                                                <input
                                                  type="checkbox"
                                                  className="peer sr-only"
                                                  checked={useScholarDefinitions}
                                                  onChange={(e) => setUseScholarDefinitions(e.target.checked)}
                                                  disabled={settingsLocked}
                                                />
                                                <div className="h-6 w-11 rounded-full bg-surface-sunken border border-line peer-checked:bg-danger peer-checked:border-danger after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-surface after:transition-transform peer-checked:after:translate-x-full peer-disabled:opacity-50"></div>
                                              </div>
                                            </label>
                                          </div>
                                        )}

			                              <div className="mt-4 flex items-center gap-2">
			                                {chapters.length === 0 && (
			                                  <Button
				                                    onClick={() => void handleStartGeneration()}
			                                    disabled={!canGenerate}
			                                    variant="primary"
			                                    size="md"
			                                    className="flex-1"
			                                  >
			                                    {isDramaProfile
			                                      ? isCloudDrama
			                                        ? 'Generate Google Cloud Drama Audiobook'
			                                        : 'Generate Audio Drama Audiobook'
			                                      : 'Start Generation'}
			                                  </Button>
			                                )}
			                                {showResumeButton && (
			                                  <Button
				                                    onClick={() => void handleStartGeneration()}
			                                    disabled={!canGenerate}
			                                    variant="primary"
			                                    size="md"
			                                    className="flex-1"
			                                  >
			                                    Resume
			                                  </Button>
			                                )}
			                                {showResetButton && (
			                                  <Button
			                                    onClick={() => setShowResetConfirm(true)}
			                                    disabled={isGenerating}
			                                    variant="danger"
			                                    size="md"
			                                    title="Delete all generated chapters/pages for this document"
			                                  >
			                                    Reset
			                                  </Button>
			                                )}
			                              </div>
                                    
                                    {/* AI Changelog Links */}
                                    {hasAnyChapters && (
                                      <div className="mt-4 pt-3 border-t border-line-soft flex items-center justify-between">
                                        <div className="text-xs text-soft font-medium">Smart AI Changelog</div>
                                        <div className="flex gap-3">
                                          <a 
                                            href={`/api/audiobook/changelog?bookId=${bookId || documentId}`} 
                                            target="_blank" 
                                            rel="noopener noreferrer"
                                            className="text-xs text-accent hover:text-accent-hover hover:underline transition-colors font-medium"
                                          >
                                            View in browser
                                          </a>
                                          <a 
                                            href={`/api/audiobook/changelog?bookId=${bookId || documentId}&download=true`} 
                                            className="text-xs text-accent hover:text-accent-hover hover:underline transition-colors font-medium"
                                          >
                                            Download .txt
                                          </a>
                                        </div>
                                      </div>
                                    )}
			                            </div>
			                          </div>
			                        )}
                        {showRegenerateHint && (
                          <div className="flex items-start justify-between bg-surface-sunken border border-line rounded-md px-3 py-2 text-xs sm:text-sm">
                            <p className="text-xs sm:text-sm text-foreground">
                              TTS audio for this chapter may be cached
                              <br />
                              Change the TTS playback options or restart the server to force uncached regeneration
                            </p>
                            <IconButton
                              onClick={() => setShowRegenerateHint(false)}
                              className="ml-3"
                              aria-label="Dismiss regenerate hint"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </IconButton>
                          </div>
                        )}
                        {/* Progress Info */}
                        {isGenerating && (
                          <ProgressCard
                            progress={progress}
                            estimatedTimeRemaining={estimatedTimeRemaining || undefined}
                            onCancel={handleCancel}
                            operationType="audiobook"
                            currentChapter={currentChapter}
                            completedChapters={chapters.filter(c => c.status === 'completed').length}
                            cancelText="Cancel"
                          />
                        )}

                        {chapters.length > 0 && (
                          <>
                            <div
                              className={`w-full space-y-2 max-h-96 overflow-y-auto ${isRefreshingChapters ? 'opacity-70 transition-opacity' : ''}`}
                              aria-busy={isRefreshingChapters}
                            >
                              <div className="flex items-center gap-2">
                                <h4 className="text-sm font-medium text-foreground">Chapters</h4>
                                {isRefreshingChapters && <ClockIcon className="h-4 w-4 text-soft animate-spin" />}
                              </div>
                              {displayChapters.map((chapter) => (
                                <div
                                  key={chapter.index}
                                  className={`flex items-center justify-between px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg bg-surface-sunken ${(regeneratingChapter === chapter.index || chapter.status === 'generating') ? 'prism-outline' : ''}`}
                                >
                                  <div className="flex items-center space-x-3 flex-1">
                                    {chapter.status === 'completed' ? (
                                      <CheckCircleIcon className="h-5 w-5 text-accent" />
                                    ) : onRegenerateChapter ? (
                                      <IconButton
                                        onClick={() => handleRegenerateChapter(chapter)}
                                        disabled={regeneratingChapter !== null || chapter.status === 'generating' || isGenerating}
                                        tone="ghost"
                                        size="sm"
                                        className="rounded-full bg-surface-sunken text-accent"
                                        title={chapter.status === 'generating' ? 'Generating...' : 'Regenerate this chapter'}
                                      >
                                        <RefreshIcon className={`h-4 w-4 ${regeneratingChapter === chapter.index || chapter.status === 'generating' ? 'animate-spin' : ''}`} />
                                      </IconButton>
                                    ) : (
                                      <ClockIcon className="h-5 w-5 text-soft" />
                                    )}
                                    <div className="flex flex-row flex-wrap items-center gap-1">
                                      <p className="text-sm font-medium text-foreground">
                                        {chapter.title}
                                      </p>
                                      <p>•</p>
                                      <p className="text-xs text-soft mt-0.5">
                                        {chapter.status !== 'completed' && <span className="text-warning">Missing • </span>}{formatDuration(chapter.duration)}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center">
                                    {((onRegenerateChapter && !isGenerating) || chapter.status === 'completed') && (
                                      <MenuRoot as="div" className="relative inline-block text-left">
                                        <MenuTrigger
                                          as={IconButton}
                                          size="sm"
                                          title="Chapter actions"
                                        >
                                          <DotsVerticalIcon className="h-5 w-5" />
                                        </MenuTrigger>
                                        <MenuTransition>
                                          <MenuItemsSurface
                                            anchor={{ to: 'bottom end', gap: '8px', padding: '12px' }}
                                            portal
                                            className="z-[70] w-44 origin-top-right bg-background focus:outline-none"
                                          >
                                            {chapter.status === 'completed' && (
                                              <>
                                                <MenuActionItem
                                                  tone="danger"
                                                  onClick={() => setPendingDeleteChapter(chapter)}
                                                  title="Delete this chapter"
                                                >
                                                  <XCircleIcon className="h-4 w-4" />
                                                  <span>Delete</span>
                                                </MenuActionItem>
                                                <MenuActionItem onClick={() => handleDownloadChapter(chapter)}>
                                                  <DownloadIcon className="h-4 w-4" />
                                                  <span>Download</span>
                                                </MenuActionItem>
                                              </>
                                            )}
                                            {regeneratingChapter === chapter.index && (
                                              <MenuActionItem
                                                tone="danger"
                                                onClick={handleCancel}
                                                title="Cancel this chapter regeneration"
                                              >
                                                <XCircleIcon className="h-4 w-4" />
                                                <span>Cancel</span>
                                              </MenuActionItem>
                                            )}
                                            {onRegenerateChapter && !isGenerating && (
                                              <MenuActionItem
                                                disabled={regeneratingChapter !== null}
                                                onClick={() => handleRegenerateChapter(chapter)}
                                                title="Regenerate this chapter"
                                              >
                                                <RefreshIcon className={`h-4 w-4 ${regeneratingChapter === chapter.index ? 'animate-spin' : ''}`} />
                                                <span>{regeneratingChapter === chapter.index ? 'Regenerating...' : 'Regenerate'}</span>
                                              </MenuActionItem>
                                            )}
                                          </MenuItemsSurface>
                                          {/* end of menu items */}
                                        </MenuTransition>
                                      </MenuRoot>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>

                            {bookId && !isGenerating && (
                              <div className="pt-4 border-t border-line-soft flex flex-col sm:flex-row gap-2">
                                <Button
                                  onClick={handleDownloadComplete}
                                  disabled={isCombining}
                                  variant="primary"
                                  size="md"
                                  className="flex-1 space-x-2"
                                >
                                  <DownloadIcon className="h-5 w-5" />
                                  <span>{isCombining ? 'Combining chapters...' : `Full Download (${format.toUpperCase()})`}</span>
                                </Button>
                                <Button
                                  onClick={() => setShowAudiobookshelfModal(true)}
                                  disabled={isCombining}
                                  variant="secondary"
                                  size="md"
                                  className="flex-1 space-x-2"
                                  title="Export this audiobook and original document directly to Audiobookshelf"
                                >
                                  <svg className="h-5 w-5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                                  </svg>
                                  <span>Add to Audiobookshelf</span>
                                </Button>
                              </div>
                            )}
                          </>
                        )}

                        {chapters.length === 0 && !isGenerating && !isLoadingExisting && (
                          <div className="text-center">
                            <p className="text-sm text-soft">
                              Audiobook settings are fixed after generation. Chapters will appear here as they are ready.
                            </p>
                          </div>
                        )}
                      </div>

                    </>
                  )}
      </ReaderSidebarShell>

      <ConfirmDialog
        isOpen={showDramaReplacementWarning}
        onClose={() => setShowDramaReplacementWarning(false)}
        onConfirm={() => {
          setShowDramaReplacementWarning(false);
          void handleStartGeneration(
            pendingDramaReplacementScholarConfirm,
            dramaNarratorVoice,
            true,
          );
        }}
        title="Replace Existing Audiobook?"
        message="A regular audiobook already exists for this document. Converting to Audio Drama will permanently delete every existing generated chapter and combined audiobook file, then regenerate the complete book with the reviewed narrator and character voices."
        confirmText="Replace & Regenerate"
        cancelText="Keep Existing Audiobook"
        isDangerous={true}
      />
      <ConfirmDialog
        isOpen={showScholarScanWarning}
        onClose={() => setShowScholarScanWarning(false)}
        onConfirm={() => {
          setShowScholarScanWarning(false);
          void handleStartGeneration(true);
        }}
        title="Pronunciation & Definition Scan Needed"
        message="This book has not completed a pronunciation and definition scan. We recommend running the Foreign Word Pre-Scan and double-checking its pronunciations first. If you continue, OpenReader will scan unresolved Greek and Hebrew terms, adopt Gemini’s recommended pronunciations, and cache short English definitions before audiobook generation."
        confirmText="Continue & Auto-Scan"
        cancelText="Review First"
        isDangerous={false}
      />
      <ConfirmDialog
        isOpen={pendingScholarRegeneration !== null}
        onClose={() => setPendingScholarRegeneration(null)}
        onConfirm={() => {
          const chapter = pendingScholarRegeneration;
          setPendingScholarRegeneration(null);
          if (chapter) void handleRegenerateChapter(chapter, true);
        }}
        title="Pronunciation & Definition Scan Needed"
        message="This chapter belongs to a Scholar audiobook whose pronunciation and definition scan is missing or incomplete. Review the book pronunciations first, or continue to let OpenReader scan this chapter and adopt Gemini’s recommended defaults before regenerating it."
        confirmText="Continue & Auto-Scan"
        cancelText="Review First"
        isDangerous={false}
      />
      <ConfirmDialog
        isOpen={showBackgroundWarning}
        onClose={() => {
          setShowBackgroundWarning(false);
          if (pendingCloseAction === 'close_modal') {
            setIsOpen(false);
          }
        }}
        title="Audiobook Generation Running"
        message="The audiobook is currently generating. If you leave, it will continue generating in the background. Do you want to explicitly stop it?"
        confirmText="Stop Generation"
        cancelText="Keep Generating (Default)"
        isDangerous={true}
        onConfirm={() => {
          handleCancel();
          setShowBackgroundWarning(false);
          if (pendingCloseAction === 'close_modal') {
            setIsOpen(false);
          }
        }}
      />
      {/* Confirm delete chapter */}
      <ConfirmDialog
        isOpen={pendingDeleteChapter !== null}
        onClose={() => setPendingDeleteChapter(null)}
        onConfirm={performDeleteChapter}
        title="Delete Chapter"
        message={pendingDeleteChapter ? `Delete "${pendingDeleteChapter.title}"? This will remove the audio and metadata for this chapter.` : ''}
        confirmText="Delete"
        cancelText="Cancel"
        isDangerous
      />
      {/* Confirm reset all */}
      <ConfirmDialog
        isOpen={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={performResetAll}
        title="Reset Audiobook"
        message="Reset audiobook? This deletes all generated chapters/pages and any combined files. This cannot be undone."
        confirmText="Reset"
        cancelText="Cancel"
        isDangerous
      />
      {/* Error dialog replacing alerts */}
      <ConfirmDialog
        isOpen={errorMessage !== null}
        onClose={() => setErrorMessage(null)}
        onConfirm={() => setErrorMessage(null)}
        title="Operation Failed"
        message={errorMessage || ''}
        confirmText="Close"
        cancelText=""
        isDangerous={false}
      />
      {showCharacterCasting && selectedSmartAudioProfileId && (
        <MultiVoiceCharacterModal
          documentId={documentId}
          profileId={selectedSmartAudioProfileId}
          workerMode={selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE ? 'drama-gemini-tts' : 'multi-voice'}
          jobId={castingJobId || undefined}
          isOpen={showCharacterCasting}
          onClose={() => {
            setStartAfterCasting(false);
            setShowCharacterCasting(false);
          }}
          onComplete={async (savedCharacterMap: SmartAudioCharacterMap) => {
            const resumedExistingJob = Boolean(castingJobId);
            const narratorVoice = applyDramaNarratorVoice(savedCharacterMap);
            setCastingJobId(null);
            setShowCharacterCasting(false);
            if (resumedExistingJob) {
              await fetchExistingChapters();
            } else if (startAfterCasting) {
              setStartAfterCasting(false);
              await handleStartGeneration(false, selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE ? null : narratorVoice);
            }
          }}
        />
      )}
      {bookId && (
        <AudiobookshelfModal
          open={showAudiobookshelfModal}
          onClose={() => setShowAudiobookshelfModal(false)}
          bookId={bookId}
          documentType={documentType}
        />
      )}
    </>
  );
}

function AudiobookSettingsSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-label="Loading audiobook settings" aria-busy="true">
      <div className="w-full rounded-lg border border-line bg-background overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line-soft bg-surface">
          <div className="h-4 w-40 rounded bg-surface-sunken" />
          <div className="h-5 w-14 rounded bg-surface-sunken" />
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="h-3 w-16 rounded bg-surface-sunken" />
              <div className="h-9 w-full rounded-md bg-surface-sunken" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-16 rounded bg-surface-sunken" />
              <div className="h-9 w-full rounded-md bg-surface-sunken" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="h-3 w-24 rounded bg-surface-sunken" />
              <div className="h-2 w-full rounded bg-surface-sunken" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-20 rounded bg-surface-sunken" />
              <div className="h-2 w-full rounded bg-surface-sunken" />
            </div>
          </div>
          <div className="h-9 w-full rounded-md bg-surface-sunken" />
        </div>
      </div>

      <div className="w-full rounded-lg border border-line bg-background overflow-hidden">
        <div className="px-4 py-3 border-b border-line-soft bg-surface">
          <div className="h-4 w-28 rounded bg-surface-sunken" />
        </div>
        <div className="p-4 space-y-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-16 rounded-lg border border-line bg-surface" />
          ))}
        </div>
      </div>
    </div>
  );
}
