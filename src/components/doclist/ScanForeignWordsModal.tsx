import React, { useState, useEffect, useMemo, useRef } from 'react';
import { ModalFrame } from '@/components/ui';
import toast from 'react-hot-toast';
import { useTtsPreviewSettings } from '@/hooks/audio/useTtsPreviewSettings';
import { PRESET_MODELS } from '@/components/constants';
import { BookPronunciationInspectorModal } from './BookPronunciationInspectorModal';
import { matchesTransliteratedTerm } from '@/lib/shared/transliteration-search';
import {
  isAutomaticallyIgnoredForeignWord,
  prepareForeignWordScanRows,
  sortForeignWordScanRows,
} from '@/lib/shared/foreign-word-scan-results';

type SuspectPronunciation = {
  word: string;
  pronunciation: string;
  warnings: string[];
};

type PronunciationLibraryScan = {
  globalSuspects: SuspectPronunciation[];
  personalSuspects: SuspectPronunciation[];
  globalWords: string[];
  personalWords: string[];
  profileName: string;
};

type SuspectDefinition = {
  term: string;
  definition: string;
  warnings: string[];
};

export function ScanForeignWordsModal({
  isOpen,
  onClose,
  documentId,
  documentName
}: {
  isOpen: boolean;
  onClose: () => void;
  documentId?: string | null;
  documentName?: string | null;
}) {
  const previewSettings = useTtsPreviewSettings();
  const [activeDocId, setActiveDocId] = useState<string | null>(documentId || null);
  const [activeDocName, setActiveDocName] = useState<string | null>(documentName || null);
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [words, setWords] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasScanned, setHasScanned] = useState(false);
  const scanInFlight = useRef(false);

  // Map to store temporary inline edits before saving
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [editingDefinition, setEditingDefinition] = useState<string | null>(null);
  const [definitionEditValue, setDefinitionEditValue] = useState<string>('');
  const [inspectWord, setInspectWord] = useState<string | null>(null);

  const [feedbackExamples, setFeedbackExamples] = useState<string[]>([]);
  const [pronunciationModel, setPronunciationModel] = useState<string | null>(null);
  const [overrideModel, setOverrideModel] = useState<string>('');
  const [overrideFallbacks, setOverrideFallbacks] = useState<[string, string]>(['', '']);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [apiKeyLast4, setApiKeyLast4] = useState<string | null>(null);
  const [backupApiKeyLast4, setBackupApiKeyLast4] = useState<string | null>(null);
  const [refineInput, setRefineInput] = useState<{ [word: string]: string }>({});
  const [refineStatus, setRefineStatus] = useState<{ [word: string]: string }>({});
  const [refineExpanded, setRefineExpanded] = useState<{ [word: string]: boolean }>({});
  const [refineRecovery, setRefineRecovery] = useState<Record<string, { message: string; feedback: string; canUseBackupKey: boolean; countdown?: number }>>({});
  const [onlyNewPronunciations, setOnlyNewPronunciations] = useState(false);
  const [generateOnlyForNewWords, setGenerateOnlyForNewWords] = useState(true);
  const [forceUseBackupKey, setForceUseBackupKey] = useState(false);
  const [sortMissingFirst, setSortMissingFirst] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [hideHealthChecks, setHideHealthChecks] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [scanJobStatus, setScanJobStatus] = useState<'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>('idle');
  const [scanJobStage, setScanJobStage] = useState<string>('idle');
  const [scanJobId, setScanJobId] = useState<string | null>(null);
  const [scanJobProgress, setScanJobProgress] = useState({ completed: 0, total: 0 });
  const [scanJobLibrarySkipped, setScanJobLibrarySkipped] = useState(0);
  const [scanJobTransliterationRejected, setScanJobTransliterationRejected] = useState(0);
  const [scanJobResolved, setScanJobResolved] = useState(0);
  const [scanJobGeneratedChoices, setScanJobGeneratedChoices] = useState(0);
  const [scanJobError, setScanJobError] = useState<string | null>(null);
  const [scanJobStatusMessage, setScanJobStatusMessage] = useState<string | null>(null);
  const scanActive = scanJobStatus === 'queued' || scanJobStatus === 'running';
  const [libraryScanStatus, setLibraryScanStatus] = useState<'idle' | 'scanning' | 'complete' | 'repairing'>('idle');
  const [libraryScan, setLibraryScan] = useState<PronunciationLibraryScan | null>(null);
  const [libraryScanError, setLibraryScanError] = useState<string | null>(null);
  const [definitionAuditStatus, setDefinitionAuditStatus] = useState<'idle' | 'scanning' | 'complete' | 'removing'>('idle');
  const [suspectDefinitions, setSuspectDefinitions] = useState<SuspectDefinition[] | null>(null);
  const [definitionAuditError, setDefinitionAuditError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ startX: number; startWidth: number } | null>(null);
  const retryTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const scanPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const modalSession = useRef(0);
  const [generatingPreviewKey, setGeneratingPreviewKey] = useState<string | null>(null);
  const previewRequestId = useRef(0);
  const previewAbortController = useRef<AbortController | null>(null);
  const activePreviewAudio = useRef<HTMLAudioElement | null>(null);
  const activePreviewUrl = useRef<string | null>(null);
  const preparedWords = useMemo(() => prepareForeignWordScanRows(words), [words]);
  const ignoredWordCount = useMemo(
    () => preparedWords.filter(isAutomaticallyIgnoredForeignWord).length,
    [preparedWords],
  );
  const sortedReviewableWords = useMemo(() => sortForeignWordScanRows(
    preparedWords.filter((word) => !isAutomaticallyIgnoredForeignWord(word)),
    { pinMissingFirst: sortMissingFirst },
  ), [preparedWords, sortMissingFirst]);

  useEffect(() => {
    modalSession.current += 1;
    const session = modalSession.current;
    if (isOpen) {
      loadFeedbackExamples();
      setWords([]);
      setError(null);
      setHasScanned(false);
      setOnlyNewPronunciations(false);
      setGenerateOnlyForNewWords(true);
      setSearchQuery('');
      setPanelWidth(null);
      setScanJobStatus('idle');
      setScanJobStage('idle');
      setScanJobId(null);
      setScanJobProgress({ completed: 0, total: 0 });
      setScanJobLibrarySkipped(0);
      setScanJobTransliterationRejected(0);
      setScanJobResolved(0);
      setScanJobGeneratedChoices(0);
      setScanJobError(null);
      setLibraryScanStatus('idle');
      setLibraryScan(null);
      setLibraryScanError(null);
      setDefinitionAuditStatus('idle');
      setSuspectDefinitions(null);
      setDefinitionAuditError(null);
      setGeneratingPreviewKey(null);
      if (documentId) {
        setActiveDocId(documentId);
        setActiveDocName(documentName || null);
        void reconnectScanJob(documentId, session);
      } else {
        loadDocuments();
      }
    } else {
      stopScanPolling();
      setWords([]);
      setError(null);
      setHasScanned(false);
      setOnlyNewPronunciations(false);
      setGenerateOnlyForNewWords(true);
      setSearchQuery('');
      setPanelWidth(null);
      setScanJobStatus('idle');
      setScanJobStage('idle');
      setScanJobId(null);
      setScanJobProgress({ completed: 0, total: 0 });
      setScanJobLibrarySkipped(0);
      setScanJobTransliterationRejected(0);
      setScanJobResolved(0);
      setScanJobGeneratedChoices(0);
      setScanJobError(null);
      setLibraryScanStatus('idle');
      setLibraryScan(null);
      setLibraryScanError(null);
      setDefinitionAuditStatus('idle');
      setSuspectDefinitions(null);
      setDefinitionAuditError(null);
      previewRequestId.current += 1;
      previewAbortController.current?.abort();
      previewAbortController.current = null;
      activePreviewAudio.current?.pause();
      activePreviewAudio.current = null;
      if (activePreviewUrl.current) URL.revokeObjectURL(activePreviewUrl.current);
      activePreviewUrl.current = null;
      setGeneratingPreviewKey(null);
      setActiveDocId(null);
      setActiveDocName(null);
    }
  }, [isOpen, documentId, documentName]);

  useEffect(() => () => {
    Object.values(retryTimers.current).forEach(clearInterval);
    if (scanPollTimer.current) clearInterval(scanPollTimer.current);
    previewRequestId.current += 1;
    previewAbortController.current?.abort();
    activePreviewAudio.current?.pause();
    if (activePreviewUrl.current) URL.revokeObjectURL(activePreviewUrl.current);
  }, []);

  const loadFeedbackExamples = async () => {
    try {
      const res = await fetch('/api/tts/refine-pronunciations');
      if (res.ok) {
        const data = await res.json();
        if (data.feedbackExamples) setFeedbackExamples(data.feedbackExamples);
        const baseModel = typeof data.pronunciationModel === 'string' ? data.pronunciationModel : 'gemini-3.8-flash';
        setPronunciationModel(baseModel);
        setOverrideModel((prev) => prev || baseModel);
        const baseFallbacks = Array.isArray(data.pronunciationModelFallbacks) && data.pronunciationModelFallbacks.length > 0
          ? [data.pronunciationModelFallbacks[0] || '', data.pronunciationModelFallbacks[1] || '']
          : ['gemini-3.7-flash', 'gemini-3.6-flash'];
        setOverrideFallbacks((prev) => (prev[0] || prev[1]) ? prev : baseFallbacks as [string, string]);
        setApiKeyLast4(typeof data.apiKeyLast4 === 'string' ? data.apiKeyLast4 : null);
        setBackupApiKeyLast4(typeof data.backupApiKeyLast4 === 'string' ? data.backupApiKeyLast4 : null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const loadDocuments = async () => {
    try {
      const res = await fetch('/api/documents');
      const data = await res.json();
      setDocuments((data.documents || []).filter((d: any) => d.type === 'pdf'));
    } catch (err) {
      console.error(err);
    }
  };

  const scanSavedPronunciations = async () => {
    setLibraryScanStatus('scanning');
    setLibraryScanError(null);
    try {
      const response = await fetch('/api/tts/global-pronunciations/rescan');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Saved pronunciation scan failed');
      setLibraryScan(data as PronunciationLibraryScan);
      setLibraryScanStatus('complete');
    } catch (scanError) {
      setLibraryScanError(scanError instanceof Error ? scanError.message : 'Saved pronunciation scan failed');
      setLibraryScanStatus('idle');
    }
  };

  const repairSuspectPronunciations = async () => {
    if (!libraryScan || (libraryScan.globalWords.length === 0 && libraryScan.personalWords.length === 0)) return;
    setLibraryScanStatus('repairing');
    setLibraryScanError(null);
    try {
      const response = await fetch('/api/tts/global-pronunciations/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          globalWords: libraryScan.globalWords,
          personalWords: libraryScan.personalWords,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Pronunciation repair failed');
      toast.success(`Repaired ${data.replacedGlobal.length} global and ${data.replacedPersonal.length} personal pronunciation entries.`);
      await scanSavedPronunciations();
    } catch (repairError) {
      const message = repairError instanceof Error ? repairError.message : 'Pronunciation repair failed';
      setLibraryScanError(message);
      setLibraryScanStatus('complete');
      toast.error(message);
    }
  };

  const scanSavedDefinitions = async () => {
    if (!activeDocId) return;
    setDefinitionAuditStatus('scanning');
    setDefinitionAuditError(null);
    try {
      const response = await fetch(`/api/documents/scan-foreign-words/definitions?documentId=${encodeURIComponent(activeDocId)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Saved definition scan failed');
      setSuspectDefinitions(Array.isArray(data.suspects) ? data.suspects : []);
      setDefinitionAuditStatus('complete');
    } catch (auditError) {
      setDefinitionAuditError(auditError instanceof Error ? auditError.message : 'Saved definition scan failed');
      setDefinitionAuditStatus('idle');
    }
  };

  const cleanSuspectDefinitions = async () => {
    if (!activeDocId || !suspectDefinitions?.length) return;
    setDefinitionAuditStatus('removing');
    setDefinitionAuditError(null);
    try {
      const response = await fetch('/api/documents/scan-foreign-words/definitions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: activeDocId,
          terms: suspectDefinitions.map(({ term }) => term),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Definition cleanup failed');
      const cleaned = new Map<string, string | null>(
        Array.isArray(data.cleaned)
          ? data.cleaned.map((item: { term: string; definition: string | null }) => [item.term, item.definition] as const)
          : [],
      );
      setWords((current) => current.map((word) => (
        cleaned.has(word.word)
          ? {
            ...word,
            definition: cleaned.get(word.word) ?? null,
            definitionNeedsReview: false,
            definitionOmitted: cleaned.get(word.word) == null,
          }
          : word
      )));
      toast.success(`Cleaned ${cleaned.size} saved definition${cleaned.size === 1 ? '' : 's'}.`);
      await scanSavedDefinitions();
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : 'Definition cleanup failed';
      setDefinitionAuditError(message);
      setDefinitionAuditStatus('complete');
      toast.error(message);
    }
  };

  const saveDefinition = async (term: string, overrideValue?: string) => {
    if (!activeDocId) return;
    try {
      const response = await fetch('/api/documents/scan-foreign-words/definitions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: activeDocId,
          term,
          definition: (overrideValue !== undefined ? overrideValue : definitionEditValue.trim()) || null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Definition update failed');
      setWords((current) => current.map((word) => (
        word.word === term
          ? {
            ...word,
            definition: data.definition,
            definitionOmitted: data.definitionOmitted,
            definitionNeedsReview: false,
          }
          : word
      )));
      setEditingDefinition(null);
      setDefinitionEditValue('');
      toast.success(data.definition ? `Updated the definition for ${term}.` : `Omitted the definition for ${term}.`);
    } catch (updateError) {
      toast.error(updateError instanceof Error ? updateError.message : 'Definition update failed');
    }
  };

  const stopScanPolling = () => {
    if (scanPollTimer.current) {
      clearInterval(scanPollTimer.current);
      scanPollTimer.current = null;
    }
  };

  const applyScanJob = (job: Record<string, any>) => {
    if (typeof job.id === 'string') setScanJobId(job.id);
    if (Array.isArray(job.words)) {
      setWords(job.words);
    }
    setHasScanned(true);
    if (job.status) setScanJobStatus(job.status);
    if (typeof job.stage === 'string') setScanJobStage(job.stage);
    setScanJobProgress({ completed: Number(job.completed) || 0, total: Number(job.total) || 0 });
    setScanJobLibrarySkipped(Number(job.librarySkipped) || 0);
    setScanJobTransliterationRejected(Number(job.transliterationRejected) || 0);
    setScanJobResolved(Number(job.resolved ?? job.generated) || 0);
    setScanJobGeneratedChoices(Number(job.generatedChoices) || 0);
    setScanJobError(job.error || (Array.isArray(job.errors) && job.errors.length > 0 ? job.errors.join(' ') : null));
    setScanJobStatusMessage(typeof job.statusMessage === 'string' ? job.statusMessage : null);
  };

  const pollScanJob = async (jobId: string) => {
    try {
      const res = await fetch(`/api/documents/scan-foreign-words/status?jobId=${encodeURIComponent(jobId)}`);
      if (!res.ok) return;
      const job = await res.json();
      applyScanJob(job);
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') stopScanPolling();
    } catch (pollError) {
      console.error('Failed to poll foreign-word scan job:', pollError);
    }
  };

  const watchScanJob = (jobId: string) => {
    stopScanPolling();
    void pollScanJob(jobId);
    scanPollTimer.current = setInterval(() => void pollScanJob(jobId), 2000);
  };

  const reconnectScanJob = async (targetId: string, session: number) => {
    try {
      const res = await fetch(`/api/documents/scan-foreign-words/status?documentId=${encodeURIComponent(targetId)}`);
      if (!res.ok || modalSession.current !== session) return;
      const job = await res.json();
      if (modalSession.current !== session) return;
      applyScanJob(job);
      if ((job.status === 'queued' || job.status === 'running') && typeof job.id === 'string') {
        watchScanJob(job.id);
      }
    } catch (reconnectError) {
      console.error('Failed to reconnect to foreign-word scan job:', reconnectError);
    }
  };

  const handleClose = () => {
    if (
      scanActive
      && !window.confirm('This scan will continue safely in the background. Close this window and reconnect when you reopen it?')
    ) {
      return;
    }
    onClose();
  };

  const cancelScan = async () => {
    if (!scanJobId || !scanActive) return;
    try {
      const response = await fetch('/api/documents/scan-foreign-words/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: scanJobId }),
      });
      const job = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(job.error || 'Failed to cancel scan');
      applyScanJob(job);
      stopScanPolling();
      toast.success('Scan cancelled. Completed results were kept.');
    } catch (cancelError) {
      toast.error(cancelError instanceof Error ? cancelError.message : 'Failed to cancel scan');
    }
  };

  const [scanMode, setScanMode] = useState<'all_foreign' | 'fantasy_litrpg' | 'greek_hebrew' | 'custom'>('all_foreign');
  const [customQuery, setCustomQuery] = useState<string>('');

  const loadWords = async (targetId: string, overrideMode?: string, overrideQuery?: string) => {
    if (scanInFlight.current || scanActive) return;

    scanInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const modeToUse = overrideMode || scanMode;
      const queryToUse = overrideQuery !== undefined ? overrideQuery : customQuery;

      const res = await fetch('/api/documents/scan-foreign-words', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId: targetId,
          mode: modeToUse,
          target: 100,
          query: queryToUse || undefined,
          generateOnlyForNewWords,
          forceUseBackupKey,
          pronunciationModel: overrideModel || pronunciationModel || undefined,
          pronunciationModelFallbacks: overrideFallbacks.filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error('Failed to scan document');
      const data = await res.json();
      setWords(data.words || []);
      setHasScanned(true);
      setScanJobStatus(data.scanStatus || 'completed');
      setScanJobStage('extracting');
      setScanJobProgress({ completed: 0, total: Number(data.scanTotal) || 0 });
      setScanJobLibrarySkipped(0);
      setScanJobTransliterationRejected(0);
      setScanJobResolved(0);
      setScanJobGeneratedChoices(0);
      setScanJobError(null);
      stopScanPolling();
      if (data.scanJobId) {
        setScanJobId(data.scanJobId);
        watchScanJob(data.scanJobId);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      scanInFlight.current = false;
      setLoading(false);
    }
  };

  const handleListen = async (word: string, phonetic: string) => {
    const previewKey = `${word}\u0000${phonetic}`;
    const requestId = previewRequestId.current + 1;
    previewRequestId.current = requestId;
    previewAbortController.current?.abort();
    const controller = new AbortController();
    previewAbortController.current = controller;
    activePreviewAudio.current?.pause();
    activePreviewAudio.current = null;
    if (activePreviewUrl.current) URL.revokeObjectURL(activePreviewUrl.current);
    activePreviewUrl.current = null;
    setGeneratingPreviewKey(previewKey);
    try {
      const textToSynthesize = phonetic ? (phonetic.startsWith('/') ? `[${word}](${phonetic})` : `[${word}](/${phonetic}/)`) : word;
      const res = await fetch(`/api/tts/preview`, {
        method: 'POST',
        headers: previewSettings.headers,
        body: JSON.stringify({ text: textToSynthesize, voice: previewSettings.voice }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('TTS Preview failed');
      const blob = await res.blob();
      if (requestId !== previewRequestId.current) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      activePreviewUrl.current = url;
      activePreviewAudio.current = audio;
      audio.addEventListener('ended', () => {
        if (activePreviewAudio.current === audio) activePreviewAudio.current = null;
        if (activePreviewUrl.current === url) activePreviewUrl.current = null;
        URL.revokeObjectURL(url);
      }, { once: true });
      await audio.play();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        console.error('Failed to listen', e);
        toast.error('Could not generate this pronunciation preview.');
      }
    } finally {
      if (requestId === previewRequestId.current) {
        previewAbortController.current = null;
        setGeneratingPreviewKey(null);
      }
    }
  };

  const handleSaveOverride = async (word: string, newPronunciation: string) => {
    try {
      // We need to fetch current profiles, update active, then save back.
      // Wait, there is no endpoint to just update a single word in the active profile.
      // We have POST /api/tts-settings to save all profiles.
      const profilesRes = await fetch('/api/tts-settings');
      const profilesData = await profilesRes.json();
      
      const updatedProfiles = profilesData.smartAudioProfiles.map((p: any) => {
        if (p.id === profilesData.selectedSmartAudioProfileId) {
          return {
            ...p,
            pronunciations: {
              ...p.pronunciations,
              [word]: newPronunciation
            }
          };
        }
        return p;
      });

      const settingsSaveRes = await fetch('/api/tts-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedSmartAudioProfileId: profilesData.selectedSmartAudioProfileId,
          smartAudioProfiles: updatedProfiles
        })
      });
      if (!settingsSaveRes.ok) throw new Error('Failed to save the personal pronunciation');

      // Also post to global pronunciations
      if (newPronunciation !== '[OMIT]') {
        const globalRes = await fetch('/api/tts/global-pronunciations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'promote-personal-default',
            word,
            phonetic: newPronunciation,
          })
        });
        if (!globalRes.ok) {
          const globalError = await globalRes.json().catch(() => ({}));
          throw new Error(globalError.error || 'Failed to promote the personal pronunciation globally');
        }
      }

      // Update local state
      setWords(words.map(w => w.word === word ? { ...w, userOverride: newPronunciation } : w));
      setEditingWord(null);
      setInspectWord(word); // Open the fuzzy search modal side-by-side
      
      // Automatically replace in text chunks
      toast.promise(
        fetch('/api/audiobooks/batch-replace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ word, newPhonetic: newPronunciation })
        }).then(async res => {
          if (!res.ok) throw new Error('Failed to replace');
          return res.json();
        }),
        {
          loading: `Searching and replacing ${word} in text...`,
          success: (data: any) => `Replaced all in document! (${data.updatedCount} text chunks updated)`,
          error: 'Failed to replace in text.'
        }
      );

    } catch (e) {
      console.error('Failed to save override', e);
    }
  };

  const clearRetryTimer = (word: string) => {
    const timer = retryTimers.current[word];
    if (timer) {
      clearInterval(timer);
      delete retryTimers.current[word];
    }
  };

  const handleRefine = async (word: string, customPrompt?: string, useBackupKey = false) => {
    clearRetryTimer(word);
    setRefineRecovery(prev => {
      const next = { ...prev };
      delete next[word];
      return next;
    });
    const feedback = customPrompt || refineInput[word] || "Generate 5 clean, standard Kokoro IPA pronunciations for this word";

    setRefineStatus(prev => ({
      ...prev,
      [word]: `Step 1/2: Asking ${pronunciationModel || 'the pronunciation model'} for 5 new variations based on your feedback...`,
    }));
    
    try {
      const wObj = words.find(w => w.word === word);
      const currentChoices = (Array.isArray(wObj?.pronunciations) ? wObj.pronunciations : []).map((p: any) => p.phonetic || p);
      
      const res = await fetch('/api/tts/refine-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, feedback, currentChoices, useBackupKey }),
      });
      
      setRefineStatus(prev => ({ ...prev, [word]: 'Step 2/2: Pre-rendering Kokoro audio buffers for instant playback...' }));
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const error = new Error(errData.error || 'Refinement failed') as Error & { canUseBackupKey?: boolean };
        error.canUseBackupKey = Boolean(errData.canUseBackupKey);
        throw error;
      }
      const data = await res.json();
      
      if (data.feedbackExamples) {
        setFeedbackExamples(data.feedbackExamples);
      }
      
      if (data.newChoices) {
        setWords(prev => prev.map(w => {
          if (w.word === word) {
            const newProns = data.newChoices.map((c: string) => ({ phonetic: c, usageCount: 0 }));
            return { ...w, pronunciations: [...(w.pronunciations || []), ...newProns] };
          }
          return w;
        }));
      }
    } catch (e: any) {
      console.error('Failed to refine', e);
      const errMsg = e.message || 'Failed to generate choices';
      toast.error(errMsg, { duration: 6000 });
      setRefineStatus(prev => ({ ...prev, [word]: '' }));
      setRefineRecovery(prev => ({
        ...prev,
        [word]: { message: errMsg, feedback, canUseBackupKey: Boolean(e.canUseBackupKey) },
      }));
    } finally {
      setRefineInput(prev => ({ ...prev, [word]: '' }));
    }
  };

  const scheduleRefineRetry = (word: string, delaySeconds: number) => {
    clearRetryTimer(word);
    setRefineRecovery(prev => ({ ...prev, [word]: { ...prev[word], countdown: delaySeconds } }));
    let secondsLeft = delaySeconds;
    retryTimers.current[word] = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearRetryTimer(word);
        void handleRefine(word, refineRecovery[word]?.feedback);
        return;
      }
      setRefineRecovery(prev => prev[word] ? { ...prev, [word]: { ...prev[word], countdown: secondsLeft } } : prev);
    }, 1000);
  };

  const handleResizePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    resizeStart.current = {
      startX: event.clientX,
      startWidth: panelRef.current.getBoundingClientRect().width,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleResizePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return;
    const maxWidth = Math.max(320, window.innerWidth - 32);
    const nextWidth = Math.min(maxWidth, Math.max(320, resizeStart.current.startWidth + event.clientX - resizeStart.current.startX));
    setPanelWidth(nextWidth);
  };

  const handleResizePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    resizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };


  return (
    <>
      {inspectWord && (
        <BookPronunciationInspectorModal
          isOpen={true}
          onClose={() => setInspectWord(null)}
          initialSearchQuery={inspectWord}
          initialUseFuzzySearch={true}
          isShiftedRight={true}
          initialBookId={activeDocId || undefined}
        />
      )}
      <ModalFrame
        open={isOpen}
        onClose={handleClose}
        size="xl"
        panelClassName={`w-[56rem] !max-w-[calc(100vw-2rem)] sm:min-w-[32rem] transition-transform duration-300 ${inspectWord ? '-translate-x-[25vw]' : ''}`}
        panelStyle={panelWidth ? { width: `${panelWidth}px` } : undefined}
        panelRef={panelRef}
        panelTestId="scan-foreign-words-modal"
      >
      <div className="relative flex flex-col max-h-[80vh]">
        <div className="p-4 border-b dark:border-gray-800 flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Foreign Word Pronunciation & Definition Pre-Scan 🔍</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {activeDocName
                  ? loading
                    ? `Scanning ${activeDocName}`
                    : `Selected ${activeDocName}`
                  : "Select a PDF to scan"}
              </p>
              <p className="hidden text-[11px] text-muted sm:block">
                Drag the lower-right corner to resize this window.
              </p>
              {pronunciationModel && (
                <div className="flex flex-col gap-1.5 text-[11px] text-purple-700 dark:text-purple-300">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <span>Pronunciation model:</span>
                      <select
                        aria-label="Pronunciation model"
                        value={overrideModel || pronunciationModel}
                        onChange={(e) => {
                          const newModel = e.target.value;
                          setOverrideModel(newModel);
                          if (newModel === 'gemini-3.8-flash') setOverrideFallbacks(['gemini-3.7-flash', 'gemini-3.6-flash']);
                          else if (newModel === 'gemini-3.7-flash') setOverrideFallbacks(['gemini-3.6-flash', 'gemini-3.5-flash']);
                          else if (newModel === 'gemini-3.6-flash') setOverrideFallbacks(['gemini-3.5-flash', 'gemini-2.5-flash']);
                        }}
                        disabled={loading || scanActive}
                        className="rounded border border-purple-300 bg-white px-1.5 py-0.5 text-[11px] font-mono font-semibold text-purple-900 shadow-sm dark:border-purple-700 dark:bg-gray-800 dark:text-purple-100 cursor-pointer"
                      >
                        {PRESET_MODELS.filter(m => m.id !== 'custom').map((m) => (
                          <option key={m.id} value={m.id}>{m.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setShowModelConfig((prev) => !prev)}
                        className="text-[10px] underline hover:text-purple-900 dark:hover:text-purple-100 ml-1 font-medium"
                        title="Configure fallback models"
                      >
                        {showModelConfig ? 'Hide fallbacks ▲' : 'Fallbacks ▾'}
                      </button>
                    </div>
                    {apiKeyLast4 ? (
                      <span>Primary API Key: <span className="font-mono font-semibold">{apiKeyLast4}</span></span>
                    ) : null}
                    {backupApiKeyLast4 ? (
                      <span>Backup API Key: <span className="font-mono font-semibold">{backupApiKeyLast4}</span></span>
                    ) : null}
                    {!apiKeyLast4 && !backupApiKeyLast4 && (
                      <div className="flex items-center gap-2 rounded bg-amber-500/15 px-2 py-0.5 text-amber-700 dark:text-amber-300 font-semibold border border-amber-500/30">
                        <span>⚠️ No Gemini API Key configured!</span>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            window.dispatchEvent(new CustomEvent('open-smart-audio-settings'));
                          }}
                          className="underline hover:text-amber-900 dark:hover:text-amber-100 font-bold ml-1"
                        >
                          Configure Key in Smart Audio Settings →
                        </button>
                      </div>
                    )}
                  </div>

                  {showModelConfig && (
                    <div className="flex flex-wrap items-center gap-2 rounded border border-purple-200 bg-purple-50/60 px-2 py-1.5 text-[11px] text-purple-900 dark:border-purple-800/60 dark:bg-purple-950/30 dark:text-purple-200">
                      <span className="font-semibold">Fallback chain:</span>
                      <div className="flex items-center gap-1.5 font-mono">
                        <span className="font-bold">{overrideModel || pronunciationModel}</span>
                        <span>→</span>
                        <select
                          aria-label="Fallback model 1"
                          value={overrideFallbacks[0] || ''}
                          onChange={(e) => setOverrideFallbacks([e.target.value, overrideFallbacks[1]])}
                          disabled={loading || scanActive}
                          className="rounded border border-purple-300 bg-white px-1 py-0.5 text-[10px] dark:border-purple-700 dark:bg-gray-800"
                        >
                          <option value="">(No Fallback 1)</option>
                          {PRESET_MODELS.filter(m => m.id !== 'custom' && m.id !== (overrideModel || pronunciationModel)).map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                        <span>→</span>
                        <select
                          aria-label="Fallback model 2"
                          value={overrideFallbacks[1] || ''}
                          onChange={(e) => setOverrideFallbacks([overrideFallbacks[0], e.target.value])}
                          disabled={loading || scanActive}
                          className="rounded border border-purple-300 bg-white px-1 py-0.5 text-[10px] dark:border-purple-700 dark:bg-gray-800"
                        >
                          <option value="">(No Fallback 2)</option>
                          {PRESET_MODELS.filter(m => m.id !== 'custom' && m.id !== (overrideModel || pronunciationModel) && m.id !== overrideFallbacks[0]).map((m) => (
                            <option key={m.id} value={m.id}>{m.id}</option>
                          ))}
                        </select>
                      </div>
                      <span className="text-[10px] text-gray-500 dark:text-gray-400">
                        (Tried in order if {overrideModel || pronunciationModel} is overloaded/503)
                      </span>
                    </div>
                  )}
                </div>
              )}
              {scanJobStatus === 'queued' || scanJobStatus === 'running' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="space-y-0.5">
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    Pre-scan: {scanJobProgress.total > 0
                      ? `${scanJobProgress.completed}/${scanJobProgress.total} terms processed`
                      : scanJobStage === 'extracting'
                        ? 'extracting PDF candidates on the CPU; term progress begins when extraction finishes'
                        : 'queued'}…
                  </p>
                  {scanJobLibrarySkipped > 0 && (
                    <p className="text-[11px] text-blue-700 dark:text-blue-300">
                      Library matches skipped by Gemini: {scanJobLibrarySkipped}
                    </p>
                  )}
                  {scanJobStatusMessage && (
                    <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 animate-pulse">
                      {scanJobStatusMessage}
                    </p>
                  )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void cancelScan()}
                    className="rounded border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300"
                  >
                    Cancel scan
                  </button>
                </div>
              ) : scanJobStatus === 'completed' && (scanJobProgress.total > 0 || scanJobLibrarySkipped > 0) ? (
                <div className="space-y-0.5">
                  {scanJobLibrarySkipped > 0 && (
                    <p className="text-[11px] text-blue-700 dark:text-blue-300">Library matches skipped by Gemini: {scanJobLibrarySkipped}</p>
                  )}
                  {scanJobTransliterationRejected > 0 && (
                    <p className="text-[11px] text-soft">Non-biblical Latin candidates ignored: {scanJobTransliterationRejected}</p>
                  )}
                  {scanJobError ? (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300">Gemini processed {scanJobProgress.completed}/{scanJobProgress.total} terms and generated {scanJobGeneratedChoices} new pronunciation choices. {scanJobError}</p>
                  ) : (
                    <p className="text-[11px] text-green-700 dark:text-green-300">Gemini processed {scanJobProgress.completed}/{scanJobProgress.total} terms and generated {scanJobGeneratedChoices} new pronunciation choices.</p>
                  )}
                  {scanJobProgress.completed > scanJobResolved && (
                    <p className="text-[11px] font-bold text-red-600 dark:text-red-400">
                      ⚠️ {scanJobProgress.completed - scanJobResolved} terms need manual review because Gemini omitted them or returned no usable pronunciation.
                    </p>
                  )}
                </div>
              ) : scanJobStatus === 'failed' ? (
                <p className="text-[11px] text-red-600 dark:text-red-400">Pronunciation generation failed: {scanJobError || 'check server logs'}</p>
              ) : scanJobStatus === 'cancelled' ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">Scan cancelled. Completed results were kept; you can restart it later.</p>
              ) : null}
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                Preview voice: {previewSettings.voice} · {previewSettings.provider}/{previewSettings.model}
              </p>
            </div>
            <button onClick={handleClose} className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 text-lg font-bold">✕</button>
          </div>

          {activeDocId && (
            <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-gray-50 dark:bg-gray-800/60 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Target Type:</span>
                <select
                  value={scanMode}
                  onChange={(e: any) => setScanMode(e.target.value)}
                  disabled={loading || scanActive}
                  className="px-2.5 py-1 text-xs border rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-700 font-medium"
                >
                  <option value="all_foreign">🌐 All Foreign Languages (Greek, Hebrew, Cyrillic, CJK, etc.)</option>
                  <option value="fantasy_litrpg">⚔️ Fantasy & LitRPG (Proper Nouns, Stat Names, Races)</option>
                  <option value="greek_hebrew">🏛️ Biblical Scholarship (Greek, Hebrew & Latin Transliteration)</option>
                  <option value="custom">🔍 Custom Term Search</option>
                </select>

                {scanMode === 'custom' && (
                  <input
                    type="text"
                    value={customQuery}
                    onChange={(e) => setCustomQuery(e.target.value)}
                    disabled={loading || scanActive}
                    placeholder="Enter word to search (e.g. Xylar)"
                    className="px-2.5 py-1 text-xs border rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-700"
                  />
                )}
                {scanMode === 'greek_hebrew' && (
                  <span className="max-w-md text-[11px] text-soft">
                    Includes uncommon Latin-letter forms such as phronein; Gemini confirms the biblical language before anything is saved.
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">Coverage: Full 100%</span>
                <span className="text-xs text-gray-500 dark:text-gray-400">Required before creating a Scholar audiobook.</span>

                <button
                  type="button"
                  onClick={() => activeDocId && loadWords(activeDocId)}
                  disabled={loading || scanActive}
                  className="px-3 py-1 bg-accent hover:bg-secondary-accent text-background font-bold text-xs rounded transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loading ? 'Scanning…' : hasScanned ? 'Scan Again' : 'Start Scan'}
                </button>
                <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap" title="Avoids extra Gemini calls for words that already have a global pronunciation.">
                  <input
                    type="checkbox"
                    checked={generateOnlyForNewWords}
                    onChange={(event) => setGenerateOnlyForNewWords(event.target.checked)}
                    disabled={loading || scanActive}
                  />
                  Generate 5 only for new words (skip existing global/profile pronunciations)
                </label>
                {backupApiKeyLast4 && (
                  <label className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300 font-semibold whitespace-nowrap" title="Bypasses the primary API key and uses the backup Gemini key immediately for this scan.">
                    <input
                      type="checkbox"
                      checked={forceUseBackupKey}
                      onChange={(event) => setForceUseBackupKey(event.target.checked)}
                      disabled={loading || scanActive}
                    />
                    ⚡ Force backup API key immediately ({backupApiKeyLast4})
                  </label>
                )}
                {hasScanned && (
                  <>
                    <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={onlyNewPronunciations}
                        onChange={(event) => setOnlyNewPronunciations(event.target.checked)}
                        disabled={loading || scanActive}
                      />
                      New global choices only
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-300 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={hideHealthChecks}
                        onChange={(event) => setHideHealthChecks(event.target.checked)}
                      />
                      Hide health checks
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-purple-700 dark:text-purple-300 font-semibold whitespace-nowrap" title="Optional: override the default combined fuzzy-frequency order by putting missing pronunciations first.">
                      <input
                        type="checkbox"
                        checked={sortMissingFirst}
                        onChange={(event) => setSortMissingFirst(event.target.checked)}
                        disabled={loading}
                      />
                      📌 Override fuzzy order: missing first
                    </label>
                  </>
                )}
              </div>
            </div>
          )}

          {!hideHealthChecks && (
            <div className="rounded-lg border border-accent-line bg-accent-wash p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground">Saved pronunciation health check</h4>
                <p className="mt-0.5 text-xs text-soft">
                  Scan both the global pronunciation library and the selected profile&apos;s personal library for malformed or Kokoro-incompatible entries.
                  Gemini&apos;s first safe replacement is automatically selected as the default, so no manual adoption is required.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void scanSavedPronunciations()}
                  disabled={libraryScanStatus === 'scanning' || libraryScanStatus === 'repairing'}
                  className="rounded border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent-wash disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {libraryScanStatus === 'scanning' ? 'Scanning both libraries…' : libraryScan ? 'Scan Again' : 'Scan Saved Pronunciations'}
                </button>
                {libraryScan && (libraryScan.globalWords.length > 0 || libraryScan.personalWords.length > 0) && (
                  <button
                    type="button"
                    onClick={() => void repairSuspectPronunciations()}
                    disabled={libraryScanStatus === 'scanning' || libraryScanStatus === 'repairing'}
                    className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-background hover:bg-secondary-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {libraryScanStatus === 'repairing' ? 'Repairing suspects…' : 'Repair All Suspects with Gemini'}
                  </button>
                )}
              </div>
            </div>
            {libraryScanError && (
              <p className="mt-2 text-xs font-medium text-danger">{libraryScanError}</p>
            )}
            {libraryScan && (
              <div className="mt-3 text-xs text-foreground">
                <p className="font-semibold">
                  Found {libraryScan.globalWords.length} global and {libraryScan.personalWords.length} personal suspect word{libraryScan.globalWords.length + libraryScan.personalWords.length === 1 ? '' : 's'} in {libraryScan.profileName}.
                </p>
                {libraryScan.globalSuspects.length === 0 && libraryScan.personalSuspects.length === 0 ? (
                  <p className="mt-1 text-accent">No improperly formed saved pronunciations were found.</p>
                ) : (
                  <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded border border-line bg-surface p-2">
                    {([
                      ['Global library', libraryScan.globalSuspects],
                      [`Personal library — ${libraryScan.profileName}`, libraryScan.personalSuspects],
                    ] as const).map(([label, suspects]) => suspects.length > 0 && (
                      <div key={label}>
                        <p className="font-semibold">{label}</p>
                        {suspects.map((suspect, index) => (
                          <p key={`${label}-${suspect.word}-${suspect.pronunciation}-${index}`} className="mt-1 [overflow-wrap:anywhere]">
                            <strong>{suspect.word}</strong>: <code>{suspect.pronunciation}</code> — {suspect.warnings.join(' ')}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {!hideHealthChecks && activeDocId && (
            <div className="rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-foreground">Saved definition health check</h4>
                  <p className="mt-0.5 text-xs text-soft">
                    Find multiple-meaning glosses, placeholders, and connector-only definitions. Keep one useful meaning and omit entries that should not be narrated.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void scanSavedDefinitions()}
                    disabled={definitionAuditStatus === 'scanning' || definitionAuditStatus === 'removing'}
                    className="rounded border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-accent-wash disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {definitionAuditStatus === 'scanning' ? 'Scanning definitions…' : suspectDefinitions ? 'Scan Again' : 'Scan Saved Definitions'}
                  </button>
                  {suspectDefinitions && suspectDefinitions.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void cleanSuspectDefinitions()}
                      disabled={definitionAuditStatus === 'scanning' || definitionAuditStatus === 'removing'}
                      className="rounded bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {definitionAuditStatus === 'removing' ? 'Cleaning definitions…' : 'Clean Up All Suspect Definitions'}
                    </button>
                  )}
                </div>
              </div>
              {definitionAuditError && (
                <p className="mt-2 text-xs font-medium text-danger">{definitionAuditError}</p>
              )}
              {suspectDefinitions && (
                <div className="mt-3 text-xs text-foreground">
                  {suspectDefinitions.length === 0 ? (
                    <p className="text-accent">No unusable saved definitions were found for this document.</p>
                  ) : (
                    <div className="max-h-36 space-y-1 overflow-y-auto rounded border border-line bg-surface p-2">
                      {suspectDefinitions.map((suspect) => (
                        <p key={suspect.term} className="[overflow-wrap:anywhere]">
                          <strong>{suspect.term}</strong>: &quot;{suspect.definition}&quot; — {suspect.warnings.join(' ')}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          {hasScanned && (
            <div className="mb-4">
              <input
                type="text"
                placeholder="Search words..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full max-w-sm px-3 py-1.5 text-sm border rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-700 focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
          )}
          {!activeDocId ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">Choose a PDF from your library to scan for foreign words:</p>
              <div className="flex flex-col gap-2">
                {documents.map(doc => (
                  <button 
                    key={doc.id} 
                    type="button"
                    className="p-3 text-left border rounded-lg bg-gray-50 dark:bg-gray-800 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors font-medium text-sm flex items-center gap-2"
                    onClick={() => {
                      setActiveDocId(doc.id);
                      setActiveDocName(doc.name);
                      setWords([]);
                      setError(null);
                      setHasScanned(false);
                      setSuspectDefinitions(null);
                      setDefinitionAuditStatus('idle');
                      setDefinitionAuditError(null);
                      modalSession.current += 1;
                      void reconnectScanJob(doc.id, modalSession.current);
                    }}
                  >
                    📄 {doc.name}
                  </button>
                ))}
                {documents.length === 0 && <p className="text-sm text-gray-500">No PDFs found in your library.</p>}
              </div>
            </div>
          ) : loading || (scanActive && words.length === 0) ? (
            <div className="flex flex-col items-center justify-center p-12 text-center">
              <div className="text-gray-900 dark:text-gray-100 font-semibold mb-2 text-lg">Scanning document (this may take a minute)...</div>
              <p className="text-gray-500 dark:text-gray-400 text-sm max-w-md">
                You can safely close this modal or navigate away. The scan will continue in the background, and all LLM pronunciation generations will automatically be saved to your database for when you return!
              </p>
            </div>
          ) : error ? (
            <div className="p-4 text-red-600 bg-red-50 dark:bg-red-950/40 rounded">{error}</div>
          ) : !hasScanned ? (
            <div className="p-4 text-gray-500">Choose the scan settings, then click Start Scan.</div>
          ) : words.length === 0 ? (
            <div className="p-4 text-gray-500">No foreign words found.</div>
          ) : sortedReviewableWords.length === 0 ? (
            <div className="p-4 text-gray-500">
              No reviewable foreign words found. Automatically ignored {ignoredWordCount} extraction artifact{ignoredWordCount === 1 ? '' : 's'}, low-value function term{ignoredWordCount === 1 ? '' : 's'}, or rejected Latin transliteration candidate{ignoredWordCount === 1 ? '' : 's'}.
            </div>
          ) : (
            <>
            {ignoredWordCount > 0 && (
              <div className="mb-3 rounded border border-line bg-surface-sunken px-3 py-2 text-xs text-soft">
                Automatically hidden: {ignoredWordCount} deterministic extraction artifact{ignoredWordCount === 1 ? '' : 's'}, low-value Greek/Hebrew function term{ignoredWordCount === 1 ? '' : 's'}, or Latin candidate Gemini did not recognize as Greek/Hebrew. Complete recognized words remain reviewable.
              </div>
            )}
            <table className="w-full table-fixed text-sm text-left">
              <colgroup>
                <col className="w-[16%]" />
                <col className="w-[8%]" />
                <col className="w-[36%]" />
                <col className="w-[20%]" />
                <col className="w-[20%]" />
              </colgroup>
              <thead className="bg-gray-100 dark:bg-gray-800 sticky top-0">
                <tr>
                  <th className="px-4 py-2">Word</th>
                  <th className="px-4 py-2 text-right">Count</th>
                  <th className="px-4 py-2">AI Pronunciation Options</th>
                  <th className="px-4 py-2">English Definition</th>
                  <th className="px-4 py-2">Your Override</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedReviewableWords
                  .filter((w) => !searchQuery || matchesTransliteratedTerm(w.word, searchQuery))
                  .map((w, i) => {
                  const isMissing = (!w.pronunciations || w.pronunciations.length === 0) && !w.userOverride;
                  return (
                  <tr key={i} className={`transition-colors ${isMissing ? 'bg-amber-50/60 dark:bg-amber-950/20 hover:bg-amber-100/60 dark:hover:bg-amber-900/30' : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
                    <td className="px-4 py-3 font-medium text-lg text-gray-900 dark:text-gray-100 align-top [overflow-wrap:anywhere]">
                      <div className="flex flex-col gap-1">
                        <span>{w.word}</span>
                        {Array.isArray(w.fuzzyGroupVariants) && w.fuzzyGroupVariants.length > 1 && (
                          <span
                            className="inline-block w-fit rounded bg-accent-wash px-1.5 py-0.5 text-[10px] font-semibold text-accent border border-accent-line"
                            title={`Fuzzy group: ${w.fuzzyGroupVariants.join(', ')}`}
                          >
                            Fuzzy priority · {w.fuzzyGroupCount} combined · {w.fuzzyGroupVariants.length} direct variants
                          </span>
                        )}
                        {isMissing && (
                          <span className="inline-block w-fit rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300 border border-amber-500/30">
                            ⚠️ Missing / Needs Fix
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500 align-top">{w.count}</td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-col gap-2">
                        {(Array.isArray(w.pronunciations) ? w.pronunciations : [])
                          .filter((p: any) => !onlyNewPronunciations || p?.isInGlobalLibrary !== true)
                          .map((p: any, idx: number) => {
                          const phoneticStr = p.phonetic || p;
                          const isMatch = w.userOverride === phoneticStr;
                          const isLibraryPronunciation = w.libraryPronunciation === phoneticStr;
                          const isTransliterationMatch = p?.isTransliterationMatch === true;
                          const isGeminiRecommendation = w.pronunciationSource === 'gemini' && w.geminiRecommendedPronunciation === phoneticStr;
                          const previewKey = `${w.word}\u0000${phoneticStr}`;
                          const isGeneratingPreview = generatingPreviewKey === previewKey;
                          return (
                            <div key={idx} className={`flex items-center gap-2 p-1.5 rounded border ${isLibraryPronunciation ? 'bg-green-50 border-green-300 dark:bg-green-900/30 dark:border-green-800' : isGeminiRecommendation ? 'bg-red-50 border-red-300 dark:bg-red-900/30 dark:border-red-800' : isMatch ? 'bg-blue-100 border-blue-300 dark:bg-blue-900/30 dark:border-blue-800' : 'border-transparent hover:border-gray-200 dark:hover:border-gray-700'}`}>
                              <span className={`font-mono text-xs flex-1 ${isLibraryPronunciation ? 'text-green-700 dark:text-green-300' : isGeminiRecommendation ? 'text-red-700 dark:text-red-300' : 'text-purple-600 dark:text-purple-400'}`}>
                                {phoneticStr}
                              </span>
                              {isLibraryPronunciation && isTransliterationMatch && <span className="text-[10px] font-semibold text-green-700 dark:text-green-300">Transliteration: {w.transliterationSourceTerm}</span>}
                              {isLibraryPronunciation && !isTransliterationMatch && <span className="text-[10px] font-semibold text-green-700 dark:text-green-300">Library</span>}
                              {isGeminiRecommendation && <span className="text-[10px] font-semibold text-red-700 dark:text-red-300">Gemini pick</span>}
                              <button
                                type="button"
                                className="px-2 py-0.5 text-[10px] font-semibold bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded hover:bg-gray-300"
                                onClick={() => handleListen(w.word, phoneticStr)}
                                disabled={isGeneratingPreview}
                                aria-busy={isGeneratingPreview}
                              >
                                {isGeneratingPreview && <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]" aria-hidden="true" />}
                                {isGeneratingPreview ? 'Generating…' : 'Listen'}
                              </button>
                              <button
                                type="button"
                                className="px-2 py-0.5 text-[10px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 rounded hover:bg-blue-200"
                                onClick={() => handleSaveOverride(w.word, phoneticStr)}
                              >
                                Adopt
                              </button>
                            </div>
                          );
                          })}
                        {(!w.pronunciations || w.pronunciations.length === 0) && (
                          <span className="text-gray-500 text-xs italic">
                            {scanJobStatus === 'queued' || scanJobStatus === 'running'
                              ? 'Waiting for Gemini pronunciation choices…'
                              : 'No Gemini pronunciation was generated for this word; see the scan status above.'}
                          </span>
                        )}
                        {onlyNewPronunciations && Array.isArray(w.pronunciations) && w.pronunciations.length > 0 && w.pronunciations.every((p: any) => p?.isInGlobalLibrary === true) && (
                          <span className="text-gray-500 text-xs italic">No pronunciations are new to the global list.</span>
                        )}
                      </div>
                      
                      {/* Refinement Section */}
                      <div className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700">
                        <button
                          type="button"
                          className="text-xs text-blue-600 dark:text-blue-400 font-medium hover:underline flex items-center gap-1"
                          onClick={() => {
                            const isOpening = !refineExpanded[w.word];
                            setRefineExpanded(prev => ({ ...prev, [w.word]: isOpening }));
                            if (isOpening && (!w.pronunciations || w.pronunciations.length === 0)) {
                              void handleRefine(w.word);
                            }
                          }}
                        >
                          {refineExpanded[w.word] ? '▼ Hide Refinement' : '▶ Refine with AI'}
                        </button>
                        
                        {refineExpanded[w.word] && (
                          <div className="mt-2 flex flex-col gap-2">
                            <input
                              type="text"
                              value={refineInput[w.word] || ''}
                              onChange={e => setRefineInput(prev => ({ ...prev, [w.word]: e.target.value }))}
                              placeholder="e.g. Make the ending sound like -een instead of -ayn"
                              className="w-full px-2 py-1.5 text-sm border rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border-gray-300 dark:border-gray-700"
                            />
                            
                            {feedbackExamples.length > 0 && (
                              <div className="flex flex-col gap-1">
                                <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Recent Community Feedback Examples:</span>
                                <div className="flex flex-wrap gap-1">
                                  {feedbackExamples.map((ex, idx) => (
                                    <button
                                      key={idx}
                                      type="button"
                                      className="px-2 py-1 text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-left border border-gray-200 dark:border-gray-700 max-w-full truncate"
                                      onClick={() => {
                                        setRefineInput(prev => ({ ...prev, [w.word]: ex }));
                                        void handleRefine(w.word, ex);
                                      }}
                                      title={ex}
                                    >
                                      {ex}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                            
                            <button
                              type="button"
                              className="self-start mt-1 px-3 py-1.5 text-xs font-semibold bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 border border-purple-300 dark:border-purple-800 rounded hover:bg-purple-200 dark:hover:bg-purple-900/60 transition-colors disabled:opacity-50"
                              onClick={() => handleRefine(w.word)}
                              disabled={!!refineStatus[w.word]}
                            >
                              Generate 5 New Variations ✨
                            </button>
                            
                            {refineStatus[w.word] && (
                              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium animate-pulse mt-1">
                                {refineStatus[w.word]}
                              </span>
                            )}

                            {refineRecovery[w.word] && (
                              <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                                <div className="font-medium">⚠️ {refineRecovery[w.word].message}</div>
                                {refineRecovery[w.word].countdown ? (
                                  <div className="mt-1">Retrying in {refineRecovery[w.word].countdown}s…</div>
                                ) : (
                                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                    {refineRecovery[w.word].canUseBackupKey && (
                                      <button
                                        type="button"
                                        className="rounded bg-purple-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-purple-700"
                                        onClick={() => void handleRefine(w.word, refineRecovery[w.word].feedback, true)}
                                      >
                                        Try paid API key
                                      </button>
                                    )}
                                    <span className="text-[10px] font-semibold">Retry in:</span>
                                    {[30, 60, 120, 240].map((delay) => (
                                      <button
                                        key={delay}
                                        type="button"
                                        className="rounded bg-amber-200 px-2 py-1 text-[10px] font-semibold text-amber-900 hover:bg-amber-300 dark:bg-amber-800 dark:text-amber-100"
                                        onClick={() => scheduleRefineRetry(w.word, delay)}
                                      >
                                        {delay}s
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {editingDefinition === w.word ? (
                        <div className="flex min-w-48 flex-col gap-2">
                          <input
                            type="text"
                            value={definitionEditValue}
                            onChange={(event) => setDefinitionEditValue(event.target.value)}
                            placeholder="Blank omits this definition"
                            className="w-full rounded border border-blue-500 bg-white px-2 py-1 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100"
                            autoFocus
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveDefinition(w.word);
                              if (event.key === 'Escape') setEditingDefinition(null);
                            }}
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => void saveDefinition(w.word)}
                              className="rounded bg-green-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-green-700"
                            >
                              Save Definition
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingDefinition(null)}
                              className="rounded bg-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveDefinition(w.word, '')}
                              className="rounded bg-red-100 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-200 dark:bg-red-900 dark:text-red-300 ml-auto"
                            >
                              Null
                            </button>
                          </div>
                        </div>
                      ) : w.definition ? (
                        <div>
                          <span className={w.definitionNeedsReview
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-gray-800 dark:text-gray-200'}
                          >
                            {w.definition}
                          </span>
                          {w.definitionNeedsReview && (
                            <p className="mt-1 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                              Double-check this definition
                            </p>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingDefinition(w.word);
                              setDefinitionEditValue(w.definition || '');
                            }}
                            className="mt-1 block text-[10px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                          >
                            Edit definition
                          </button>
                        </div>
                      ) : (
                        <div>
                          <span className="text-xs italic text-gray-500">
                            {scanJobStatus === 'queued' || scanJobStatus === 'running'
                              ? 'Waiting for scan…'
                              : w.definitionOmitted
                                ? 'Definition intentionally omitted'
                                : 'No contextual definition'}
                          </span>
                          {!scanActive && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingDefinition(w.word);
                                setDefinitionEditValue('');
                              }}
                              className="mt-1 block text-[10px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                            >
                              Add definition
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {editingWord === w.word ? (
                        <div className="flex flex-col gap-2">
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-full px-2 py-1 text-sm border rounded bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 border-blue-500"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveOverride(w.word, editValue);
                              if (e.key === 'Escape') setEditingWord(null);
                            }}
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="px-2.5 py-1 text-xs font-semibold bg-green-600 text-white rounded hover:bg-green-700"
                              onClick={() => handleSaveOverride(w.word, editValue)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="px-2.5 py-1 text-xs font-semibold bg-gray-200 text-gray-800 rounded hover:bg-gray-300"
                              onClick={() => setEditingWord(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="px-2.5 py-1 text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300 rounded hover:bg-red-200 ml-auto"
                              onClick={() => handleSaveOverride(w.word, '[OMIT]')}
                            >
                              Null
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          <span className={`font-medium font-mono text-xs ${w.userOverride === '[OMIT]' ? 'text-amber-700 dark:text-amber-300 font-bold' : w.userOverride ? 'text-green-700 dark:text-green-300' : 'text-gray-500'}`}>
                            {w.userOverride === '[OMIT]' ? '🚫 Omitted' : w.userOverride || '-'}
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              className="px-2 py-0.5 text-[10px] font-semibold bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded hover:bg-gray-300"
                              onClick={() => {
                                setEditingWord(w.word);
                                setEditValue(w.userOverride && w.userOverride !== '[OMIT]' ? w.userOverride : w.geminiRecommendedPronunciation || '');
                              }}
                            >
                              Edit IPA
                            </button>
                            <button
                              type="button"
                              className="px-2 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-300 dark:border-amber-800 rounded hover:bg-amber-200"
                              onClick={() => handleSaveOverride(w.word, '[OMIT]')}
                              title="Marks this word to be skipped/omitted during pronunciation."
                            >
                              🚫 Omit
                            </button>
                            {w.userOverride && w.userOverride !== '[OMIT]' && (
                              <button
                                type="button"
                                className="px-2 py-0.5 text-[10px] font-semibold bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded hover:bg-gray-300 self-start"
                                onClick={() => handleListen(w.word, w.userOverride)}
                                disabled={generatingPreviewKey === `${w.word}\u0000${w.userOverride}`}
                                aria-busy={generatingPreviewKey === `${w.word}\u0000${w.userOverride}`}
                              >
                                {generatingPreviewKey === `${w.word}\u0000${w.userOverride}` && <span className="mr-1 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]" aria-hidden="true" />}
                                {generatingPreviewKey === `${w.word}\u0000${w.userOverride}` ? 'Generating…' : 'Listen'}
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            </>
          )}
        </div>
        <div
          role="separator"
          aria-label="Resize pronunciation scan dialog"
          className="absolute bottom-0 right-0 z-10 h-5 w-5 cursor-ew-resize touch-none"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
        >
          <span className="absolute bottom-1 right-1 h-3 w-3 border-b-2 border-r-2 border-gray-400" />
        </div>
      </div>
    </ModalFrame>
    </>
  );
}
