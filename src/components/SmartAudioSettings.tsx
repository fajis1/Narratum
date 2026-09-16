/* eslint-disable no-restricted-syntax */
"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BASE_ABBREVIATIONS, BASE_BOOKS, PRESET_MODELS, PRESET_PROMPTS } from './constants';
import type { SmartAudioProfile } from '@/types/client';
import { toast } from 'react-hot-toast';
import { ScanForeignWordsModal } from './doclist/ScanForeignWordsModal';
import { BookPronunciationInspectorModal } from './doclist/BookPronunciationInspectorModal';
import { SmartAudioWizardModal } from './SmartAudioWizardModal';
import { PronunciationGuideManager } from './PronunciationGuideManager';
import {
  DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE,
  getKokoroPronunciationQualityWarnings,
} from '@/lib/shared/kokoro-pronunciation-policy';
import {
  DEFAULT_CLEANUP_AI_MODEL,
  DEFAULT_PRONUNCIATION_AI_MODEL,
} from '@/lib/shared/smart-audio-models';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useTtsPreviewSettings } from '@/hooks/audio/useTtsPreviewSettings';

const EMPTY_PROFILE = (): SmartAudioProfile => ({
  id: `profile-${Date.now()}`,
  name: 'New Profile',
  aiModel: DEFAULT_CLEANUP_AI_MODEL,
  aiModelFallbacks: [],
  pronunciationAiModel: DEFAULT_PRONUNCIATION_AI_MODEL,
  customTtsPrompt: '',
  abbreviations: {},
  pronunciations: {},
  books: {},
  pronunciationPromptMode: 'default',
  customPronunciationPrompt: '',
  workerMode: 'standard',
});

const WORKER_MODES = [
  {
    id: 'multi-voice' as const,
    icon: '🎭',
    label: 'LitRPG Audio Drama',
    badge: 'Reviewed character voices',
    description: 'Scans the book for speaking characters, pauses for you to review the cast and preview Kokoro voices, then assigns validated narrator and dialogue segments for every chapter.',
    features: ['Review cast before generation', 'Character aliases and voice previews', 'Validated speaker assignment', 'Chapter-by-chapter Audio Drama studio', 'Fantasy pronunciation library support'],
    presetName: 'LitRPG Audio Drama',
  },
  {
    id: 'standard' as const,
    icon: '⚡',
    label: 'Standard AI Cleaner',
    badge: 'General purpose',
    description: 'Cleans formatting, fixes OCR errors, expands Bible citations (e.g. "Jn 3:16" → "John chapter 3 verse 16"), and applies your custom abbreviation and pronunciation lists. Best for general audiobooks, novels, and non-fiction.',
    features: ['OCR & hyphenation repair', 'Bible citation expansion', 'Custom abbreviations & pronunciations', 'TTS cadence optimization', 'Kokoro IPA markup for Greek & Hebrew'],
    presetName: 'Standard Audiobook Cleaner',
  },
  {
    id: 'scholar' as const,
    icon: '📖',
    label: 'Biblical Scholar & Theology',
    badge: 'Academic & ancient languages',
    description: 'Uses the book’s pronunciation pre-scan to insert saved contextual English definitions next to isolated Koine Greek and Biblical Hebrew words, then performs the same single cleanup pass. If the book has not been scanned, OpenReader warns before generation and can build the lexicon automatically.',
    features: ['Everything in Standard', 'Cached Greek & Hebrew contextual definitions', 'Strict Erasmian + Academic Hebrew IPA markup', 'One Gemini cleanup call per chunk', 'Full changelog / diff generation', 'Book-specific definition review'],
    presetName: 'Biblical Scholar & Theology',
  },
];

function objectToEntries(value: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(value).map(([key, val]) => ({ key, value: val }));
}

function entriesToObject(entries: Array<{ key: string; value: string }>): Record<string, string> {
  return entries.reduce<Record<string, string>>((acc, entry) => {
    const key = entry.key.trim();
    const value = entry.value.trim();
    if (!key || !value) return acc;
    acc[key] = value;
    return acc;
  }, {});
}

function formatMaskedKey(configured?: boolean, last4?: string): string | null {
  if (!configured) return null;
  return `••••••••••••${last4 || ''}`;
}

type GlobalPronunciationImportPreview = {
  library: unknown;
  validWords: number;
  validChoices: number;
  issues: Array<{ word: string; pronunciation?: string; reason: string }>;
  validDefinitions: number;
  definitionIssues: Array<{ term: string; reason: string }>;
};

type CommonEnglishCandidate = {
  word: string;
  zipfFrequency: number;
  choices: string[];
  removable: boolean;
  protectedChoices: number;
};

export function SmartAudioSettings() {
  const { data: session } = useAuthSession();
  const previewSettings = useTtsPreviewSettings();
  const isAdmin = Boolean(
    (session?.user as unknown as { isAdmin?: boolean } | undefined)?.isAdmin,
  );
  const [apiKey, setApiKey] = useState('');
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [backupApiKey, setBackupApiKey] = useState('');
  const [maskedBackupKey, setMaskedBackupKey] = useState<string | null>(null);
  const [groqApiKey, setGroqApiKey] = useState('');
  const [maskedGroqKey, setMaskedGroqKey] = useState<string | null>(null);
  const [providerOrder, setProviderOrder] = useState<Array<'gemini_primary' | 'gemini_backup' | 'groq'>>(['gemini_primary', 'gemini_backup', 'groq']);
  const [profiles, setProfiles] = useState<SmartAudioProfile[]>([]);
  const [workerMode, setWorkerMode] = useState<'standard' | 'scholar' | 'bibliography-catcher' | 'multi-voice'>('standard');
  const [useGlobalPronunciations, setUseGlobalPronunciations] = useState<boolean>(true);
  const [pronunciationPromptMode, setPronunciationPromptMode] = useState<'default' | 'custom'>('default');
  const [customPronunciationPrompt, setCustomPronunciationPrompt] = useState('');
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [profileName, setProfileName] = useState('');
  const [aiModel, setAiModel] = useState(DEFAULT_CLEANUP_AI_MODEL);
  const [customModelId, setCustomModelId] = useState('');
  const [fallbackAiModels, setFallbackAiModels] = useState<[string, string]>(['', '']);
  const [customFallbackModelIds, setCustomFallbackModelIds] = useState<[string, string]>(['', '']);
  const [pronunciationAiModel, setPronunciationAiModel] = useState(DEFAULT_PRONUNCIATION_AI_MODEL);
  const [customPronunciationModelId, setCustomPronunciationModelId] = useState('');
  const [promptMode, setPromptMode] = useState<'preset' | 'custom'>('preset');
  const [selectedPromptName, setSelectedPromptName] = useState<string>(PRESET_PROMPTS[0]?.name || '');
  const [prompt, setPrompt] = useState('');
  const [abbreviations, setAbbreviations] = useState(BASE_ABBREVIATIONS.map(({ key, value }) => ({ key, value })));
  const [pronunciations, setPronunciations] = useState<Array<{ key: string; value: string }>>([]);
  const [books, setBooks] = useState(BASE_BOOKS.map(({ key, value }) => ({ key, value })));
  const [selectedAbbrevs, setSelectedAbbrevs] = useState<number[]>([]);
  const [selectedBooks, setSelectedBooks] = useState<number[]>([]);
  const [newAbbrev, setNewAbbrev] = useState({ key: '', value: '' });
  const [newBook, setNewBook] = useState({ key: '', value: '' });
  const [isLoading, setIsLoading] = useState(true);
  const [isRestoringBuiltInProfiles, setIsRestoringBuiltInProfiles] = useState(false);

  const [isGlobalModalOpen, setIsGlobalModalOpen] = useState(false);
  const [globalPronunciations, setGlobalPronunciations] = useState<{key: string; values: string[]}[]>([]);
  const [isLoadingGlobal, setIsLoadingGlobal] = useState(false);
  // Tracks the single currently-playing variant as "word::phonetic" so only that row is disabled
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [globalLangFilter, setGlobalLangFilter] = useState<'all' | 'greek' | 'hebrew' | 'latin'>('all');
  const [globalAlphaFilter, setGlobalAlphaFilter] = useState<string | null>(null);
  const [showSuspectPronunciationsOnly, setShowSuspectPronunciationsOnly] = useState(false);
  const [isRescanningSuspects, setIsRescanningSuspects] = useState(false);
  const [globalRefineInput, setGlobalRefineInput] = useState<Record<string, string>>({});
  const [globalRefineStatus, setGlobalRefineStatus] = useState<Record<string, string>>({});
  const [globalRefineChoices, setGlobalRefineChoices] = useState<Record<string, string[]>>({});
  const [globalRefineDefault, setGlobalRefineDefault] = useState<Record<string, number>>({});
  const [editingPersonalSuspect, setEditingPersonalSuspect] = useState<string | null>(null);
  const [personalSuspectEditValue, setPersonalSuspectEditValue] = useState('');
  const [isSavingPersonalSuspect, setIsSavingPersonalSuspect] = useState(false);
  const globalImportInputRef = useRef<HTMLInputElement>(null);
  const [globalImportPreview, setGlobalImportPreview] = useState<GlobalPronunciationImportPreview | null>(null);
  const [replaceImportedGlobalEntries, setReplaceImportedGlobalEntries] = useState(false);
  const [isImportingGlobalPronunciations, setIsImportingGlobalPronunciations] = useState(false);
  const [commonEnglishCandidates, setCommonEnglishCandidates] = useState<CommonEnglishCandidate[] | null>(null);
  const [selectedCommonEnglishWords, setSelectedCommonEnglishWords] = useState<string[]>([]);
  const [isScanningCommonEnglish, setIsScanningCommonEnglish] = useState(false);
  const [isRemovingCommonEnglish, setIsRemovingCommonEnglish] = useState(false);

  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);

  const handleSaveUniversalSetup = async (config: {
    universalApiKey: string;
    backupApiKey: string;
    cleanupModel: string;
    pronunciationModel: string;
    chosenWorkerMode: 'standard' | 'scholar';
    useGlobal: boolean;
    importGlobal: boolean;
  }) => {
    try {
      const primaryKeySourceProfileId = activeProfile?.geminiApiKeySourceProfileId
        || activeProfile?.id
        || selectedProfileId;
      const backupKeySourceProfileId = activeProfile?.backupGeminiApiKeySourceProfileId
        || activeProfile?.id
        || selectedProfileId;

      // 1. Update API key in settings if provided
      if (config.universalApiKey) {
        await fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'geminiApiKey', value: config.universalApiKey })
        });
      }
      if (config.backupApiKey) {
        await fetch('/api/admin/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'backupGeminiApiKey', value: config.backupApiKey })
        });
      }

      // 2. Cascade API Key and Model to ALL profiles
      const updatedProfiles = profiles.map(p => ({
        ...p,
        ...(config.universalApiKey.trim()
          ? { geminiApiKey: config.universalApiKey.trim() }
          : (primaryKeySourceProfileId && activeProfile?.geminiApiKeyConfigured
            ? { geminiApiKeySourceProfileId: primaryKeySourceProfileId }
            : {})),
        ...(config.backupApiKey.trim()
          ? { backupGeminiApiKey: config.backupApiKey.trim() }
          : (backupKeySourceProfileId && activeProfile?.backupGeminiApiKeyConfigured
            ? { backupGeminiApiKeySourceProfileId: backupKeySourceProfileId }
            : {})),
        aiModel: config.cleanupModel,
        pronunciationAiModel: config.pronunciationModel,
        workerMode: config.chosenWorkerMode
      }));

      // If user chose importGlobal, fetch global pronunciations and merge
      if (config.importGlobal) {
        const res = await fetch('/api/tts/global-pronunciations');
        if (res.ok) {
          const globalData = await res.json();
          const resolvedGlobal: Record<string, string> = {};
          for (const [key, val] of Object.entries(globalData)) {
            if (Array.isArray(val) && val.length > 0) resolvedGlobal[key] = val[0] as string;
            else if (typeof val === 'string') resolvedGlobal[key] = val;
          }
          if (updatedProfiles[0]) {
            updatedProfiles[0].pronunciations = { ...resolvedGlobal, ...updatedProfiles[0].pronunciations };
          }
        }
      }

      setUseGlobalPronunciations(config.useGlobal);

      // Save profiles back to server
      const response = await fetch('/api/tts-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedSmartAudioProfileId: selectedProfileId || updatedProfiles[0]?.id || '',
          smartAudioProfiles: updatedProfiles
        })
      });
      if (!response.ok) throw new Error('Failed to save Smart Audio profiles');
      const saved = await response.json();
      setProfiles(Array.isArray(saved.smartAudioProfiles) ? saved.smartAudioProfiles : []);
      setSelectedProfileId(
        typeof saved.selectedSmartAudioProfileId === 'string'
          ? saved.selectedSmartAudioProfileId
          : selectedProfileId,
      );

      toast.success('Universal Setup applied across all profiles!');
    } catch (e) {
      console.error('Failed to save universal setup', e);
      toast.error('Failed to save setup');
    }
  };

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) || profiles[0] || null,
    [profiles, selectedProfileId],
  );

  const loadProfiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/tts-settings');
      if (!response.ok) throw new Error('Failed to load Smart Audio profiles');
      const data = await response.json();
      setProfiles(Array.isArray(data.smartAudioProfiles) ? data.smartAudioProfiles : []);
      const nextSelected = typeof data.selectedSmartAudioProfileId === 'string' && data.selectedSmartAudioProfileId
        ? data.selectedSmartAudioProfileId
        : (Array.isArray(data.smartAudioProfiles) && data.smartAudioProfiles[0]?.id) || '';
      setSelectedProfileId(nextSelected);
      if (typeof data.selectedSmartAudioProfileId === 'string' && data.selectedSmartAudioProfileId) {
        setSelectedProfileId(data.selectedSmartAudioProfileId);
      }
    } catch (error) {
      console.error('Failed to load smart-audio settings:', error);
      const fallback = EMPTY_PROFILE();
      setProfiles([fallback]);
      setSelectedProfileId(fallback.id);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const handleRestoreMissingBuiltInProfiles = useCallback(async () => {
    setIsRestoringBuiltInProfiles(true);
    try {
      const response = await fetch('/api/tts-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restoreMissingBuiltInProfiles: true }),
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        smartAudioProfiles?: SmartAudioProfile[];
        restoredProfiles?: Array<{ id: string; name: string }>;
      };
      if (!response.ok) throw new Error(data.error || 'Failed to restore built-in profiles.');

      const serverProfiles = Array.isArray(data.smartAudioProfiles) ? data.smartAudioProfiles : [];
      setProfiles((currentProfiles) => {
        const currentIds = new Set(currentProfiles.map((profile) => profile.id));
        const missingFromClient = serverProfiles.filter((profile) => !currentIds.has(profile.id));
        return [...currentProfiles, ...missingFromClient];
      });

      const restoredProfiles = Array.isArray(data.restoredProfiles) ? data.restoredProfiles : [];
      if (restoredProfiles.length === 0) {
        toast.success('All built-in Smart Audio profiles are already available.');
      } else {
        toast.success(
          `Restored ${restoredProfiles.length} built-in profile${restoredProfiles.length === 1 ? '' : 's'}: ${restoredProfiles.map((profile) => profile.name).join(', ')}`,
        );
      }
      window.dispatchEvent(new CustomEvent('smart-audio-profiles-updated'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to restore built-in profiles.');
    } finally {
      setIsRestoringBuiltInProfiles(false);
    }
  }, []);

  const loadGlobalPronunciations = async () => {
    setIsLoadingGlobal(true);
    setIsGlobalModalOpen(true);
    try {
      const res = await fetch('/api/tts/global-pronunciations');
      const data = await res.json();
      setGlobalPronunciations(Object.entries(data).map(([key, value]) => {
        const rawArr = Array.isArray(value) ? value : [value];
        const stringValues = rawArr.map((item: unknown) => {
          if (typeof item !== 'object' || item === null) return String(item);
          if ('phonetic' in item && typeof item.phonetic === 'string') return item.phonetic;
          return JSON.stringify(item);
        });
        return { key, values: stringValues };
      }));
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingGlobal(false);
    }
  };

  const scanCommonEnglishPronunciations = async () => {
    setIsScanningCommonEnglish(true);
    try {
      const response = await fetch('/api/tts/global-pronunciations/common-english', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'scan' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Common-English scan failed.');
      const candidates = Array.isArray(data.candidates) ? data.candidates as CommonEnglishCandidate[] : [];
      setCommonEnglishCandidates(candidates);
      setSelectedCommonEnglishWords(candidates.filter((candidate) => candidate.removable).map((candidate) => candidate.word));
      toast.success(`Found ${candidates.length} machine-generated common-English ${candidates.length === 1 ? 'entry' : 'entries'}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Common-English scan failed.');
    } finally {
      setIsScanningCommonEnglish(false);
    }
  };

  const removeSelectedCommonEnglishPronunciations = async () => {
    if (selectedCommonEnglishWords.length === 0) return;
    if (!window.confirm(
      `Remove ${selectedCommonEnglishWords.length} selected common-English ${selectedCommonEnglishWords.length === 1 ? 'word' : 'words'} from the global dictionary, global definitions, and every saved book lexicon? Human-created choices are protected.`,
    )) return;
    setIsRemovingCommonEnglish(true);
    try {
      const response = await fetch('/api/tts/global-pronunciations/common-english', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', words: selectedCommonEnglishWords }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to remove common-English entries.');
      toast.success(
        `Removed ${data.removedWords?.length || 0} global words and ${data.bookLexiconEntriesRemoved || 0} linked book ${data.bookLexiconEntriesRemoved === 1 ? 'entry' : 'entries'}.`,
      );
      setCommonEnglishCandidates(null);
      setSelectedCommonEnglishWords([]);
      await loadGlobalPronunciations();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove common-English entries.');
    } finally {
      setIsRemovingCommonEnglish(false);
    }
  };

  const exportGlobalPronunciations = async () => {
    try {
      const response = await fetch('/api/tts/global-pronunciations/export');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to export global pronunciations');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'openreader-global-dictionary.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export global pronunciations');
    }
  };

  const previewGlobalPronunciationImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const library = JSON.parse(await file.text()) as unknown;
      const response = await fetch('/api/tts/global-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview-import', library }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to validate global pronunciation import');
      setGlobalImportPreview({ library, ...data });
      setReplaceImportedGlobalEntries(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to read global pronunciation import');
    }
  };

  const importGlobalPronunciations = async () => {
    if (!globalImportPreview || globalImportPreview.validWords === 0) return;
    setIsImportingGlobalPronunciations(true);
    try {
      const response = await fetch('/api/tts/global-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'import',
          library: globalImportPreview.library,
          mode: replaceImportedGlobalEntries ? 'replace-imported' : 'merge',
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to import global pronunciations');
      toast.success(`Imported ${data.importedChoices || 0} pronunciation choice${data.importedChoices === 1 ? '' : 's'} and ${data.importedDefinitions || 0} definition${data.importedDefinitions === 1 ? '' : 's'}.`);
      setGlobalImportPreview(null);
      await loadGlobalPronunciations();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import global pronunciations');
    } finally {
      setIsImportingGlobalPronunciations(false);
    }
  };

  const handleAdoptGlobal = async (word: string, phonetic: string) => {
    const trimmed = phonetic.trim();
    const normalizedPhonetic = trimmed.startsWith('/') && trimmed.endsWith('/')
      ? trimmed
      : `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
    setPronunciations((prev) => {
      const filtered = prev.filter(p => p.key !== word);
      return [{ key: word, value: normalizedPhonetic }, ...filtered];
    });

    try {
      await fetch('/api/tts/global-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, phonetic: normalizedPhonetic })
      });
      loadGlobalPronunciations();
    } catch(e) {
      console.error(e);
    }
  };

  const handleRefineGlobal = async (word: string, currentChoices: string[]) => {
    const feedback = (globalRefineInput[word] || '').trim();
    if (!feedback) {
      toast.error('Tell the pronunciation AI how this word should sound.');
      return;
    }
    setGlobalRefineStatus((current) => ({ ...current, [word]: 'Asking Gemini for five replacements…' }));
    try {
      const response = await fetch('/api/tts/refine-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word, feedback, currentChoices }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to generate pronunciation choices');
      const choices = Array.isArray(data.newChoices)
        ? data.newChoices
          .filter((choice: unknown): choice is string => typeof choice === 'string')
          .map((choice: string) => {
            const trimmed = choice.trim();
            return trimmed.startsWith('/') && trimmed.endsWith('/')
              ? trimmed
              : `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
          })
          .filter((choice: string, index: number, all: string[]) => (
            choice.length > 2 && all.indexOf(choice) === index
          ))
        : [];
      if (choices.length === 0) throw new Error('Gemini returned no usable pronunciation choices.');
      setGlobalRefineChoices((current) => ({ ...current, [word]: choices }));
      setGlobalRefineDefault((current) => ({ ...current, [word]: 0 }));
      setGlobalRefineStatus((current) => ({ ...current, [word]: '' }));
    } catch (error) {
      setGlobalRefineStatus((current) => ({ ...current, [word]: '' }));
      toast.error(error instanceof Error ? error.message : 'Failed to refine global pronunciation');
    }
  };

  const handleSetGlobalDefault = async (word: string, phonetic: string) => {
    try {
      const response = await fetch('/api/tts/global-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-default', word, phonetic }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to set global default');
      toast.success(`Updated the global default for ${word}.`);
      await loadGlobalPronunciations();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to set global default');
    }
  };

  const handleApplyGlobalChoices = async (word: string) => {
    const choices = globalRefineChoices[word] || [];
    if (choices.length === 0) return;
    try {
      const response = await fetch('/api/tts/global-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'replace-choices',
          word,
          choices,
          defaultIndex: globalRefineDefault[word] || 0,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to replace global pronunciation choices');
      toast.success(`Replaced the global choices for ${word}.`);
      setGlobalRefineChoices((current) => {
        const next = { ...current };
        delete next[word];
        return next;
      });
      setGlobalRefineInput((current) => ({ ...current, [word]: '' }));
      await loadGlobalPronunciations();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to replace global pronunciation choices');
    }
  };

  const handleDeleteGlobalChoice = async (word: string, phonetic: string) => {
    if (!window.confirm(`Remove ${phonetic} from the global choices for ${word}?`)) return;
    try {
      const response = await fetch('/api/tts/global-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-choice', word, phonetic }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to remove global pronunciation');
      toast.success(`Removed a global pronunciation for ${word}.`);
      await loadGlobalPronunciations();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove global pronunciation');
    }
  };

  const handleDeleteGlobalWord = async (word: string) => {
    if (!window.confirm(`Delete ${word} and every pronunciation choice for it from the global library?`)) return;
    try {
      const response = await fetch('/api/tts/global-pronunciations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-word', word }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to delete global pronunciation word');
      setGlobalRefineInput((current) => {
        const next = { ...current };
        delete next[word];
        return next;
      });
      setGlobalRefineChoices((current) => {
        const next = { ...current };
        delete next[word];
        return next;
      });
      toast.success(`Deleted ${word} from the global pronunciation library.`);
      await loadGlobalPronunciations();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete global pronunciation word');
    }
  };

  const playPreview = async (word: string, phonetic: string) => {
    const compositeKey = `${word}::${phonetic}`;
    try {
      setPlayingKey(compositeKey);
      const textToSynthesize = phonetic.startsWith('/') ? `[${word}](${phonetic})` : phonetic;
      const res = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: previewSettings.headers,
        body: JSON.stringify({ text: textToSynthesize, voice: previewSettings.voice })
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Preview failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setPlayingKey(null);
      };
      await audio.play();
    } catch (err) {
      console.error(err);
      setPlayingKey(null);
    }
  };

  const importDiffs = useMemo(() => {
    if (!globalImportPreview?.library) return [];
    
    // First create a quick lookup for current global pronunciations
    const currentDict: Record<string, string> = {};
    globalPronunciations.forEach(item => {
      if (item.values && item.values.length > 0) {
        currentDict[item.key] = item.values[0];
      }
    });

    const diffs: { word: string; importedPhonetic: string; currentPhonetic: string | null }[] = [];
    
    for (const [word, choices] of Object.entries(globalImportPreview.library)) {
      if (!choices || choices.length === 0) continue;
      const importedPhonetic = choices[0].phonetic;
      const currentPhonetic = currentDict[word] || null;
      
      if (importedPhonetic !== currentPhonetic) {
        diffs.push({ word, importedPhonetic, currentPhonetic });
      }
    }
    
    return diffs;
  }, [globalImportPreview, globalPronunciations]);

  const suspectGlobalWords = useMemo(
    () => globalPronunciations
      .filter((item) => item.values.some(
        (phonetic) => getKokoroPronunciationQualityWarnings(item.key, phonetic).length > 0,
      ))
      .map((item) => item.key),
    [globalPronunciations],
  );
  const suspectPersonalPronunciations = useMemo(
    () => pronunciations.filter(
      (item) => getKokoroPronunciationQualityWarnings(item.key, item.value).length > 0,
    ),
    [pronunciations],
  );
  const suspectPersonalWords = useMemo(
    () => suspectPersonalPronunciations.map((item) => item.key),
    [suspectPersonalPronunciations],
  );
  const suspectWordCount = useMemo(
    () => new Set([...suspectGlobalWords, ...suspectPersonalWords]).size,
    [suspectGlobalWords, suspectPersonalWords],
  );

  const handleRescanSuspectPronunciations = async () => {
    if (suspectWordCount === 0) return;
    setIsRescanningSuspects(true);
    try {
      const response = await fetch('/api/tts/global-pronunciations/rescan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          globalWords: suspectGlobalWords,
          personalWords: suspectPersonalWords,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Pronunciation rescan failed');
      toast.success(
        `Replaced ${data.replacedGlobal.length} global and ${data.replacedPersonal.length} personal suspect pronunciation${data.replaced.length === 1 ? '' : 's'}.`,
      );
      await Promise.all([loadGlobalPronunciations(), loadProfiles()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Pronunciation rescan failed');
    } finally {
      setIsRescanningSuspects(false);
    }
  };

  const savePersonalSuspectPronunciation = async (word: string, value: string | null) => {
    const current = buildCurrentProfile();
    if (!current) return;
    const rawValue = value?.trim() || '';
    const normalized = rawValue
      ? (rawValue.startsWith('/') && rawValue.endsWith('/') ? rawValue : `/${rawValue.replace(/^\/+|\/+$/g, '')}/`)
      : null;
    if (normalized) {
      const warnings = getKokoroPronunciationQualityWarnings(word, normalized);
      if (warnings.length > 0) {
        toast.error(`Cannot save ${word}: ${warnings.join(' ')}`);
        return;
      }
    }
    const nextPronunciations = { ...current.pronunciations };
    if (normalized) nextPronunciations[word] = normalized;
    else delete nextPronunciations[word];
    const nextCurrent = { ...current, pronunciations: nextPronunciations };
    const nextProfiles = profiles.some((profile) => profile.id === nextCurrent.id)
      ? profiles.map((profile) => (profile.id === nextCurrent.id ? nextCurrent : profile))
      : [nextCurrent, ...profiles];
    setIsSavingPersonalSuspect(true);
    try {
      const response = await fetch('/api/tts-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smartAudioProfiles: nextProfiles,
          selectedSmartAudioProfileId: nextCurrent.id,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to save personal pronunciation');
      setPronunciations(objectToEntries(nextPronunciations));
      setProfiles(Array.isArray(data.smartAudioProfiles) ? data.smartAudioProfiles : nextProfiles);
      setEditingPersonalSuspect(null);
      setPersonalSuspectEditValue('');
      toast.success(normalized ? `Updated the personal pronunciation for ${word}.` : `Removed the personal override for ${word}; the global entry can now apply.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save personal pronunciation');
    } finally {
      setIsSavingPersonalSuspect(false);
    }
  };

  useEffect(() => {
    if (!activeProfile) return;
    setProfileName(activeProfile.name);
    setWorkerMode(activeProfile.workerMode ?? 'standard');
    setUseGlobalPronunciations(activeProfile.useGlobalPronunciations ?? true);
    setPronunciationPromptMode(activeProfile.pronunciationPromptMode === 'custom' ? 'custom' : 'default');
    setCustomPronunciationPrompt(activeProfile.customPronunciationPrompt || '');
    const cleanupModel = activeProfile.aiModel || DEFAULT_CLEANUP_AI_MODEL;
    const cleanupFallbacks = activeProfile.aiModelFallbacks || [];
    const pronunciationModel = activeProfile.pronunciationAiModel || cleanupModel;
    setAiModel(PRESET_MODELS.some((model) => model.id === cleanupModel) ? cleanupModel : 'custom');
    setCustomModelId(PRESET_MODELS.some((model) => model.id === cleanupModel) ? '' : cleanupModel);
    setFallbackAiModels([0, 1].map((index) => {
      const model = cleanupFallbacks[index] || '';
      return !model || PRESET_MODELS.some((preset) => preset.id === model) ? model : 'custom';
    }) as [string, string]);
    setCustomFallbackModelIds([0, 1].map((index) => {
      const model = cleanupFallbacks[index] || '';
      return model && !PRESET_MODELS.some((preset) => preset.id === model) ? model : '';
    }) as [string, string]);
    setPronunciationAiModel(
      PRESET_MODELS.some((model) => model.id === pronunciationModel) ? pronunciationModel : 'custom',
    );
    setCustomPronunciationModelId(
      PRESET_MODELS.some((model) => model.id === pronunciationModel) ? '' : pronunciationModel,
    );

    const savedPrompt = activeProfile.customTtsPrompt || '';

    // --- Legacy migration ---
    // Old profiles stored a prompt that began with a "NOTE:" UI annotation.
    // Detect that pattern and silently upgrade to the clean new preset so the
    // stale NOTE never gets sent to Gemini again.
    const isLegacyScholarPrompt =
      savedPrompt.trimStart().startsWith('NOTE:') ||
      savedPrompt.includes('automatically inject English definitions');

    const matchedPreset = isLegacyScholarPrompt
      ? PRESET_PROMPTS.find((p) => p.workerMode === 'scholar')
      : PRESET_PROMPTS.find((preset) => preset.content.trim() === savedPrompt.trim());

    if (matchedPreset) {
      setPromptMode('preset');
      setSelectedPromptName(matchedPreset.name);
      setPrompt(matchedPreset.content);
      // If we just auto-migrated, also set the worker mode card correctly.
      if (isLegacyScholarPrompt) {
        setWorkerMode('scholar');
      }
    } else {
      setPromptMode('custom');
      setSelectedPromptName('');
      setPrompt(savedPrompt);
    }
    setAbbreviations(objectToEntries(activeProfile.abbreviations || {}));
    setPronunciations(objectToEntries(activeProfile.pronunciations || {}));
    setBooks(objectToEntries(activeProfile.books || {}));
    // API-loaded profiles contain no keys. Locally duplicated, unsaved profiles
    // may still contain a key the user just typed, which must remain editable.
    setApiKey(activeProfile.geminiApiKey || '');
    setMaskedKey(formatMaskedKey(
      activeProfile.geminiApiKeyConfigured,
      activeProfile.geminiApiKeyLast4,
    ));
    setBackupApiKey(activeProfile.backupGeminiApiKey || '');
    setMaskedBackupKey(formatMaskedKey(
      activeProfile.backupGeminiApiKeyConfigured,
      activeProfile.backupGeminiApiKeyLast4,
    ));
    setGroqApiKey(activeProfile.groqApiKey || '');
    setMaskedGroqKey(formatMaskedKey(
      activeProfile.groqApiKeyConfigured,
      activeProfile.groqApiKeyLast4,
    ));
    setProviderOrder(activeProfile.providerOrder ?? ['gemini_primary', 'gemini_backup', 'groq']);
  }, [activeProfile]);

  const buildCurrentProfile = useCallback((): SmartAudioProfile | null => {
    const finalModel = aiModel === 'custom' ? customModelId.trim() : aiModel;
    const finalFallbackModels = fallbackAiModels.map((model, index) => (
      model === 'custom' ? customFallbackModelIds[index].trim() : model.trim()
    )).filter((model, index, models) => model && model !== finalModel && models.indexOf(model) === index);
    const finalPronunciationModel = pronunciationAiModel === 'custom'
      ? customPronunciationModelId.trim()
      : pronunciationAiModel;
    if (!profileName.trim()) return null;
    if (aiModel === 'custom' && !finalModel) return null;
    if (pronunciationAiModel === 'custom' && !finalPronunciationModel) return null;
    return {
      id: selectedProfileId || EMPTY_PROFILE().id,
      name: profileName.trim(),
      aiModel: finalModel || DEFAULT_CLEANUP_AI_MODEL,
      aiModelFallbacks: finalFallbackModels,
      pronunciationAiModel: finalPronunciationModel || DEFAULT_PRONUNCIATION_AI_MODEL,
      customTtsPrompt: prompt,
      abbreviations: entriesToObject(abbreviations),
      pronunciations: entriesToObject(pronunciations),
      books: entriesToObject(books),
      useGlobalPronunciations,
      pronunciationPromptMode,
      customPronunciationPrompt: pronunciationPromptMode === 'custom' ? customPronunciationPrompt.trim() : '',
      workerMode,
      geminiApiKeyConfigured: activeProfile?.geminiApiKeyConfigured,
      geminiApiKeyLast4: activeProfile?.geminiApiKeyLast4,
      backupGeminiApiKeyConfigured: activeProfile?.backupGeminiApiKeyConfigured,
      backupGeminiApiKeyLast4: activeProfile?.backupGeminiApiKeyLast4,
      groqApiKeyConfigured: activeProfile?.groqApiKeyConfigured,
      groqApiKeyLast4: activeProfile?.groqApiKeyLast4,
      geminiApiKeySourceProfileId: activeProfile?.geminiApiKeySourceProfileId,
      backupGeminiApiKeySourceProfileId: activeProfile?.backupGeminiApiKeySourceProfileId,
      // Blank/omitted key fields tell the server to preserve the stored secrets.
      ...(apiKey.trim() ? { geminiApiKey: apiKey.trim() } : {}),
      ...(backupApiKey.trim() ? { backupGeminiApiKey: backupApiKey.trim() } : {}),
      ...(groqApiKey.trim() ? { groqApiKey: groqApiKey.trim() } : {}),
      providerOrder,
    };
  }, [apiKey, backupApiKey, groqApiKey, providerOrder, aiModel, customModelId, fallbackAiModels, customFallbackModelIds, pronunciationAiModel, customPronunciationModelId, profileName, selectedProfileId, prompt, abbreviations, pronunciations, books, useGlobalPronunciations, pronunciationPromptMode, customPronunciationPrompt, workerMode, activeProfile]);

  // When the user clicks a worker mode card, always switch to the matching
  // preset for that engine. This ensures clicking a card is always a clean
  // one-click reset to the correct prompt template.
  const handleWorkerModeChange = useCallback((mode: 'standard' | 'scholar' | 'multi-voice') => {
    setWorkerMode(mode);
    const targetMode = WORKER_MODES.find((m) => m.id === mode);
    const matchingPreset = PRESET_PROMPTS.find((p) => p.name === targetMode?.presetName);
    if (matchingPreset) {
      setPromptMode('preset');
      setSelectedPromptName(matchingPreset.name);
      setPrompt(matchingPreset.content);
    }
  }, []);

  const handleNewProfile = useCallback(() => {
    const profile = EMPTY_PROFILE();
    setProfiles((current) => [profile, ...current]);
    setSelectedProfileId(profile.id);
    setProfileName(profile.name);
    setAiModel(profile.aiModel);
    setCustomModelId('');
    setFallbackAiModels(['', '']);
    setCustomFallbackModelIds(['', '']);
    setPronunciationAiModel(profile.pronunciationAiModel || DEFAULT_PRONUNCIATION_AI_MODEL);
    setCustomPronunciationModelId('');
    setPrompt(profile.customTtsPrompt);
    setAbbreviations([]);
    setPronunciations([]);
    setPronunciationPromptMode('default');
    setCustomPronunciationPrompt('');
    setBooks([]);
  }, []);

  const handleDuplicateProfile = useCallback(() => {
    const current = buildCurrentProfile();
    if (!current) return;
    const duplicate: SmartAudioProfile = {
      ...current,
      id: `${current.id}-copy-${Date.now()}`,
      name: `${current.name} Copy`,
      geminiApiKeyConfigured: Boolean(
        current.geminiApiKey || current.geminiApiKeyConfigured,
      ),
      geminiApiKeyLast4: current.geminiApiKey
        ? current.geminiApiKey.slice(-4)
        : current.geminiApiKeyLast4,
      backupGeminiApiKeyConfigured: Boolean(
        current.backupGeminiApiKey || current.backupGeminiApiKeyConfigured,
      ),
      backupGeminiApiKeyLast4: current.backupGeminiApiKey
        ? current.backupGeminiApiKey.slice(-4)
        : current.backupGeminiApiKeyLast4,
      geminiApiKeySourceProfileId: current.geminiApiKeySourceProfileId || current.id,
      backupGeminiApiKeySourceProfileId:
        current.backupGeminiApiKeySourceProfileId || current.id,
    };
    setProfiles((existing) => [duplicate, ...existing]);
    setSelectedProfileId(duplicate.id);
    setProfileName(duplicate.name);
  }, [buildCurrentProfile]);

  const handleDeleteProfile = useCallback(() => {
    if (!selectedProfileId) return;
    const nextProfiles = profiles.filter((profile) => profile.id !== selectedProfileId);
    const fallback = nextProfiles[0] || EMPTY_PROFILE();
    setProfiles(nextProfiles.length > 0 ? nextProfiles : [fallback]);
    setSelectedProfileId(nextProfiles[0]?.id || fallback.id);
  }, [profiles, selectedProfileId]);

  const handleSave = useCallback(async () => {
    const current = buildCurrentProfile();
    if (!current) {
      alert('Please enter a profile name before saving.');
      return;
    }

    const nextProfiles = profiles.some((profile) => profile.id === current.id)
      ? profiles.map((profile) => (profile.id === current.id ? current : profile))
      : [current, ...profiles];

    try {
      const response = await fetch('/api/tts-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Key is now embedded inside each profile object, not sent globally
          smartAudioProfiles: nextProfiles,
          selectedSmartAudioProfileId: current.id,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save smart audio settings');
      }

      const saved = await response.json();
      setProfiles(Array.isArray(saved.smartAudioProfiles) ? saved.smartAudioProfiles : []);
      setSelectedProfileId(
        typeof saved.selectedSmartAudioProfileId === 'string'
          ? saved.selectedSmartAudioProfileId
          : current.id,
      );
      setApiKey('');
      setBackupApiKey('');
      alert('Smart audio profile saved.');
      window.dispatchEvent(new CustomEvent('smart-audio-profiles-updated'));
    } catch (error) {
      console.error('Error saving smart audio settings:', error);
      alert('Failed to save smart audio settings. Check the server logs.');
    }
  }, [buildCurrentProfile, profiles]);

  const handleProfileChange = useCallback((nextProfileId: string) => {
    setSelectedProfileId(nextProfileId);
  }, []);

  const downloadCSV = (items: { key: string; value: string }[], filename: string) => {
    const csvContent = items.map(i => `${i.key},${i.value}`).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
  };

  const handleCSVUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
    currentItems: { key: string; value: string }[],
    setItems: (items: { key: string; value: string }[]) => void
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const newItems = text.split('\n').map((line) => {
        const [key, value] = line.split(',');
        return { key: key?.trim(), value: value?.trim() };
      }).filter((item) => item.key && item.value);

      if (currentItems.length > 0) {
        const wantsOverwrite = window.confirm('Click OK to OVERWRITE the current list, or Cancel to APPEND the new items to the bottom of the list.');
        if (wantsOverwrite) {
          const confirmOverwrite = window.confirm('You have chosen to overwrite. Are you sure you want to completely replace your current list? This cannot be undone.');
          if (confirmOverwrite) {
            setItems(newItems);
          }
        } else {
          setItems([...currentItems, ...newItems]);
        }
      } else {
        setItems(newItems);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  };

  const handleAddAbbrev = () => {
    if (!newAbbrev.key || !newAbbrev.value) return;
    setAbbreviations([...abbreviations, newAbbrev]);
    setNewAbbrev({ key: '', value: '' });
  };

  const handleAddBook = () => {
    if (!newBook.key || !newBook.value) return;
    setBooks([...books, newBook]);
    setNewBook({ key: '', value: '' });
  };

  const handlePromptModeChange = useCallback((mode: 'preset' | 'custom') => {
    setPromptMode(mode);
    if (mode === 'custom') {
      setSelectedPromptName('');
      return;
    }

    const preset = PRESET_PROMPTS.find((item) => item.name === selectedPromptName) || PRESET_PROMPTS[0];
    if (preset) {
      setSelectedPromptName(preset.name);
      setPrompt(preset.content);
    }
  }, [selectedPromptName]);

  const handlePromptPresetChange = useCallback((presetName: string) => {
    setSelectedPromptName(presetName);
    const preset = PRESET_PROMPTS.find((item) => item.name === presetName);
    if (!preset) return;
    setPromptMode('preset');
    setPrompt(preset.content);
  }, []);

  const finalModel = aiModel === 'custom' ? customModelId.trim() : aiModel;
  const finalPronunciationModel = pronunciationAiModel === 'custom'
    ? customPronunciationModelId.trim()
    : pronunciationAiModel;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-8 bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-800">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-2xl font-bold mb-1">Smart AI Profiles</h2>
          <p className="text-gray-500 text-sm">
            Create reusable Smart Audio presets for audiobook generation.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => void handleRestoreMissingBuiltInProfiles()}
            disabled={isLoading || isRestoringBuiltInProfiles}
            className="px-3 py-2 rounded bg-amber-50 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 border border-amber-200 dark:border-amber-800 text-sm font-medium text-amber-800 dark:text-amber-200 transition-colors"
            title="Add missing OpenReader presets without changing your existing profiles"
          >
            {isRestoringBuiltInProfiles ? 'Restoring…' : 'Restore missing built-ins'}
          </button>
          <button onClick={handleNewProfile} className="px-3 py-2 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm font-medium">
            New profile
          </button>
          <button onClick={handleDuplicateProfile} className="px-3 py-2 rounded bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 border border-blue-200 dark:border-blue-800 text-sm font-medium text-blue-700 dark:text-blue-300 transition-colors">
            Duplicate
          </button>
          <button onClick={handleDeleteProfile} className="px-3 py-2 rounded bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm font-medium text-red-700 dark:text-red-300">
            Delete
          </button>
        </div>
      </div>

      {/* Top Banner & Guided Setup Launcher */}
      <div className="p-4 bg-gradient-to-r from-purple-950 via-indigo-900 to-slate-900 text-white rounded-2xl shadow-xl flex flex-col md:flex-row items-center justify-between gap-4 border border-purple-800/50">
        <div className="flex items-center gap-3">
          <span className="text-4xl">🪄</span>
          <div>
            <h2 className="text-lg font-bold">Smart Audio Profile Wizard & Universal Key Setup</h2>
            <p className="text-xs text-purple-200 mt-0.5">
              Set up your Universal Gemini API key, choose your default model (Gemini 3.8 Flash), configure Biblical Scholar vs Standard settings, and explore the 12-point prompt walkthrough.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setIsWizardOpen(true)}
          className="px-5 py-2.5 bg-purple-500 hover:bg-purple-400 text-white font-bold text-xs rounded-xl shadow-lg transition-all shrink-0 flex items-center gap-2 border border-purple-300/30"
        >
          <span>✨</span> Launch Guided Setup Wizard
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold">AI Processing Engine</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Choose which background Python worker handles AI text cleaning for this profile.
            Switching engines will automatically update the prompt template if you are using a preset.
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {WORKER_MODES.map((mode) => {
            const isSelected = workerMode === mode.id;
            return (
              <button
                key={mode.id}
                type="button"
                onClick={() => handleWorkerModeChange(mode.id)}
                className={`text-left p-4 rounded-xl border-2 transition-all duration-150 ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 shadow-md'
                    : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-2xl mt-0.5">{mode.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-semibold text-sm ${
                        isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-900 dark:text-gray-100'
                      }`}>
                        {mode.label}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        isSelected
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300'
                          : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                      }`}>
                        {mode.badge}
                      </span>
                      {isSelected && (
                        <span className="ml-auto text-blue-500 dark:text-blue-400 text-base">✓</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 leading-relaxed">
                      {mode.description}
                    </p>
                    <ul className="mt-2 space-y-0.5">
                      {mode.features.map((f) => (
                        <li key={f} className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
                          <span className={`text-xs ${
                            isSelected ? 'text-blue-400' : 'text-gray-400'
                          }`}>•</span>
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className={`p-4 rounded-xl border-2 transition-all duration-150 flex flex-col items-stretch gap-4 xl:flex-row xl:items-center xl:justify-between cursor-pointer ${
        useGlobalPronunciations
          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 shadow-md'
          : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 hover:border-purple-300 dark:hover:border-purple-700 hover:shadow-sm'
      }`}
      onClick={() => setUseGlobalPronunciations(true)}>
        <div className="flex items-start gap-3">
          <span className="text-3xl mt-1">🌍</span>
          <div>
            <h3 className={`text-base font-semibold ${useGlobalPronunciations ? 'text-purple-800 dark:text-purple-300' : 'text-gray-900 dark:text-gray-100'}`}>
              Global Learned Dictionary
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              The global pronunciation and definition libraries are always applied first. A profile or book entry overrides only that individual word.
            </p>
          </div>
        </div>
        <div className="shrink-0 space-y-2 xl:text-right">
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setIsScannerOpen(true); }}
              className="text-xs font-semibold px-3 py-1.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
            >
              Pre-Scan a Document 🔍
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setIsInspectorOpen(true); }}
              className="text-xs font-semibold px-3 py-1.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded hover:bg-blue-200 dark:hover:bg-blue-800 transition-colors"
            >
              Inspect Book Pronunciations 📚
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); loadGlobalPronunciations(); }}
              className="text-xs font-semibold px-3 py-1.5 bg-purple-200 dark:bg-purple-800 text-purple-800 dark:text-purple-200 rounded hover:bg-purple-300 dark:hover:bg-purple-700 transition-colors"
            >
              View Global List
            </button>
            <div className="relative inline-flex h-6 w-11 items-center rounded-full bg-purple-600">
              <span className="inline-block h-4 w-4 translate-x-6 transform rounded-full bg-white" />
            </div>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              <input
                ref={globalImportInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => void previewGlobalPronunciationImport(event)}
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void exportGlobalPronunciations(); }}
                className="text-xs font-semibold px-3 py-1.5 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded hover:bg-green-200 dark:hover:bg-green-800 transition-colors"
              >
                Export Global JSON
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); globalImportInputRef.current?.click(); }}
                className="text-xs font-semibold px-3 py-1.5 bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 rounded hover:bg-indigo-200 dark:hover:bg-indigo-800 transition-colors"
              >
                Import Global JSON
              </button>
            </div>
          )}
        </div>
      </div>

      {isAdmin && globalImportPreview && (
        <div className="rounded-xl border border-indigo-300 bg-indigo-50 p-4 dark:border-indigo-800 dark:bg-indigo-950/30">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-indigo-900 dark:text-indigo-100">Global pronunciation import preview</h3>
              <p className="mt-1 text-xs text-indigo-800 dark:text-indigo-200">
                {globalImportPreview.validWords} safe words, {globalImportPreview.validChoices} safe pronunciation choices, and {globalImportPreview.validDefinitions} usable definitions are ready to import. {globalImportPreview.issues.length + globalImportPreview.definitionIssues.length} entries will be skipped.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setGlobalImportPreview(null)}
              className="text-xs font-semibold text-indigo-800 hover:underline dark:text-indigo-200"
            >
              Cancel
            </button>
          </div>
          <label className="mt-3 flex items-start gap-2 text-xs text-indigo-950 dark:text-indigo-100">
            <input
              type="checkbox"
              checked={replaceImportedGlobalEntries}
              onChange={(event) => setReplaceImportedGlobalEntries(event.target.checked)}
              className="mt-0.5"
            />
            <span>Replace existing choices for imported words. Leave unchecked to safely add imported choices without changing existing defaults.</span>
          </label>
          
          {importDiffs.length > 0 && (
            <div className="mt-4 bg-white dark:bg-gray-900 border border-indigo-200 dark:border-indigo-800 rounded shadow-sm overflow-hidden flex flex-col max-h-96">
              <div className="bg-indigo-100 dark:bg-indigo-900 p-2 text-xs font-bold text-indigo-900 dark:text-indigo-100">
                Pronunciation Differences ({importDiffs.length} total)
              </div>
              <div className="overflow-y-auto flex-1 p-2 space-y-2">
                {importDiffs.map((diff, idx) => (
                  <div key={idx} className="flex flex-wrap items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800 rounded border border-gray-100 dark:border-gray-700 text-xs">
                    <div className="w-full sm:w-1/3 font-bold text-gray-900 dark:text-gray-100 truncate">
                      {diff.word}
                    </div>
                    <div className="flex-1 flex flex-col sm:flex-row gap-2">
                      <div className="flex-1 p-1.5 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 rounded flex items-center justify-between">
                        <span className="truncate text-red-800 dark:text-red-200" title="Current DB default">Current: {diff.currentPhonetic || 'None'}</span>
                        {diff.currentPhonetic && (
                          <button onClick={() => void playPreview(diff.word, diff.currentPhonetic!)} className="px-1.5 py-0.5 bg-red-100 dark:bg-red-800 hover:bg-red-200 dark:hover:bg-red-700 rounded text-[10px]" title="Listen">🔊</button>
                        )}
                      </div>
                      <div className="flex-1 p-1.5 bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-900/30 rounded flex items-center justify-between">
                        <span className="truncate text-green-800 dark:text-green-200" title="Incoming Git default">Imported: {diff.importedPhonetic}</span>
                        <button onClick={() => void playPreview(diff.word, diff.importedPhonetic)} className="px-1.5 py-0.5 bg-green-100 dark:bg-green-800 hover:bg-green-200 dark:hover:bg-green-700 rounded text-[10px]" title="Listen">🔊</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(globalImportPreview.issues.length > 0 || globalImportPreview.definitionIssues.length > 0) && (
            <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
              <p className="font-semibold">Skipped malformed or duplicate entries</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {[...globalImportPreview.issues.map((issue) => ({ term: issue.word, value: issue.pronunciation, reason: issue.reason })), ...globalImportPreview.definitionIssues.map((issue) => ({ term: issue.term, value: undefined, reason: issue.reason }))].slice(0, 20).map((issue, index) => (
                  <li key={`${issue.term}-${issue.value || ''}-${index}`}>
                    <span className="font-mono">{issue.term || '(unnamed entry)'}</span>{issue.value ? ` — ${issue.value}` : ''}: {issue.reason}
                  </li>
                ))}
              </ul>
              {globalImportPreview.issues.length + globalImportPreview.definitionIssues.length > 20 && (
                <p className="mt-1">Showing the first 20 of {globalImportPreview.issues.length + globalImportPreview.definitionIssues.length} skipped entries.</p>
              )}
            </div>
          )}
          <button
            type="button"
            disabled={(globalImportPreview.validWords === 0 && globalImportPreview.validDefinitions === 0) || isImportingGlobalPronunciations}
            onClick={() => void importGlobalPronunciations()}
            className="mt-3 rounded bg-indigo-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isImportingGlobalPronunciations ? 'Importing…' : `Import ${globalImportPreview.validWords} Safe Words and ${globalImportPreview.validDefinitions} Definitions`}
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-4 p-4 border rounded dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="space-y-2">
            <label className="block text-sm font-semibold">Profile</label>
            <select
              className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100 cursor-pointer"
              value={selectedProfileId}
              onChange={(e) => handleProfileChange(e.target.value)}
              disabled={isLoading}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.name}</option>
              ))}
              {profiles.length === 0 && <option value="">No profiles found</option>}
            </select>
            <input
              type="text"
              className="w-full p-2 border rounded bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-900 dark:text-gray-100"
              placeholder="Profile name"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
            />
            <p className="text-xs text-gray-400">This name appears in the audiobook generator profile selector.</p>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-end gap-2">
              <label className="block text-sm font-semibold">Primary Gemini API Key (e.g. Free Tier)</label>
              {maskedKey && (
                <span className="text-xs font-mono bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded">Active: {maskedKey}</span>
              )}
            </div>
            <input
              type="password"
              className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100"
              placeholder={maskedKey ? 'Enter a new primary key to overwrite...' : 'Enter your API key...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-end gap-2">
              <label className="block text-sm font-semibold">Backup Gemini API Key (e.g. Paid Tier)</label>
              {maskedBackupKey && (
                <span className="text-xs font-mono bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400 px-2 py-0.5 rounded">Active: {maskedBackupKey}</span>
              )}
            </div>
            <input
              type="password"
              className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100"
              placeholder={maskedBackupKey ? 'Enter a new backup key to overwrite...' : 'Enter your backup API key...'}
              value={backupApiKey}
              onChange={(e) => setBackupApiKey(e.target.value)}
            />
            <p className="text-xs text-gray-400">
              {maskedKey || maskedBackupKey ? 'Leave blank to keep using the saved key for this profile.' : 'Required. Keys are saved securely to this profile. The backup key is automatically used if the primary key hits a rate limit.'}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex justify-between items-end gap-2">
              <label className="block text-sm font-semibold">Groq API Key (Free Fallback)</label>
              {maskedGroqKey && (
                <span className="text-xs font-mono bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 px-2 py-0.5 rounded">Active: {maskedGroqKey}</span>
              )}
            </div>
            <input
              type="password"
              className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100"
              placeholder={maskedGroqKey ? 'Enter a new Groq key to overwrite...' : 'Enter your free Groq API key...'}
              value={groqApiKey}
              onChange={(e) => setGroqApiKey(e.target.value)}
            />
            <p className="text-xs text-gray-400">
              Optional free fallback used automatically if both Gemini keys exhaust their billing quota. Get a free key at{' '}
              <a href="https://console.groq.com" target="_blank" rel="noopener noreferrer" className="underline">console.groq.com</a>.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-semibold">Scan Provider Order</label>
            <p className="text-xs text-gray-400 mb-2">
              Set the order in which providers are tried for each scan batch. Any provider whose key isn&apos;t configured is automatically skipped.
            </p>
            <div className="flex flex-col gap-2">
              {([0, 1, 2] as const).map((slot) => {
                const PROVIDER_LABELS: Record<string, string> = {
                  gemini_primary: 'Gemini — Primary Key',
                  gemini_backup: 'Gemini — Backup Key',
                  groq: 'Groq (Free)',
                };
                const others = providerOrder.filter((_, idx) => idx !== slot);
                return (
                  <div key={slot} className="flex items-center gap-2">
                    <span className="text-xs font-mono text-gray-500 w-5 shrink-0">{slot + 1}.</span>
                    <select
                      className="flex-1 p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100 text-sm cursor-pointer"
                      value={providerOrder[slot] ?? ''}
                      onChange={(e) => {
                        const chosen = e.target.value as 'gemini_primary' | 'gemini_backup' | 'groq';
                        const next = [...providerOrder] as typeof providerOrder;
                        // Swap if the chosen value is already in another slot
                        const existingSlot = next.findIndex((p, i) => i !== slot && p === chosen);
                        if (existingSlot !== -1) next[existingSlot] = next[slot];
                        next[slot] = chosen;
                        setProviderOrder(next);
                      }}
                    >
                      {(['gemini_primary', 'gemini_backup', 'groq'] as const).map((p) => (
                        <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                      ))}
                    </select>
                    {others.includes(providerOrder[slot]) && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">duplicate</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-4 p-4 border rounded dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 lg:col-span-2">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3">
              <label className="block text-sm font-semibold">PDF & Audiobook Cleanup Model</label>
              <select
                className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100 cursor-pointer"
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value)}
              >
                {PRESET_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              {aiModel === 'custom' && (
                <input
                  type="text"
                  className="w-full p-2 border rounded bg-white dark:bg-gray-900 border-blue-400 dark:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400 text-sm font-mono shadow-inner"
                  placeholder="e.g., gemini-1.5-pro-tuning-v2"
                  value={customModelId}
                  onChange={(e) => setCustomModelId(e.target.value)}
                />
              )}
              <p className="text-xs text-gray-400">
                Used for high-volume OCR and manuscript cleanup. Flash-Lite is recommended to reduce cost.
              </p>
              <div className="space-y-3 pt-2 border-t border-gray-200 dark:border-gray-700">
                <div>
                  <div className="text-sm font-semibold">Optional cleanup fallbacks</div>
                  <p className="text-xs text-gray-400 mt-1">
                    Tried in order when the active model reaches a quota or remains overloaded. If every selected model fails, the book pauses for 24 hours. Leave blank to disable.
                  </p>
                </div>
                {fallbackAiModels.map((model, index) => (
                  <div key={index} className="space-y-2">
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300">
                      Backup model {index + 1}
                    </label>
                    <select
                      aria-label={`Cleanup backup model ${index + 1}`}
                      className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100 cursor-pointer"
                      value={model}
                      onChange={(event) => setFallbackAiModels((current) => {
                        const next: [string, string] = [current[0], current[1]];
                        next[index] = event.target.value;
                        return next;
                      })}
                    >
                      <option value="">No backup model</option>
                      {PRESET_MODELS.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.name}</option>
                      ))}
                    </select>
                    {model === 'custom' && (
                      <input
                        type="text"
                        aria-label={`Custom cleanup backup model ${index + 1}`}
                        className="w-full p-2 border rounded bg-white dark:bg-gray-900 border-blue-400 dark:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400 text-sm font-mono shadow-inner"
                        placeholder="Custom Gemini model identifier"
                        value={customFallbackModelIds[index]}
                        onChange={(event) => setCustomFallbackModelIds((current) => {
                          const next: [string, string] = [current[0], current[1]];
                          next[index] = event.target.value;
                          return next;
                        })}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <label className="block text-sm font-semibold">Pronunciation Model</label>
              <select
                className="w-full p-2 border rounded bg-gray-50 dark:bg-gray-800 dark:border-gray-700 text-gray-900 dark:text-gray-100 cursor-pointer"
                value={pronunciationAiModel}
                onChange={(e) => setPronunciationAiModel(e.target.value)}
              >
                {PRESET_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              {pronunciationAiModel === 'custom' && (
                <input
                  type="text"
                  className="w-full p-2 border rounded bg-white dark:bg-gray-900 border-blue-400 dark:border-blue-500 text-gray-900 dark:text-gray-100 placeholder-gray-400 text-sm font-mono shadow-inner"
                  placeholder="e.g., gemini-3.8-flash"
                  value={customPronunciationModelId}
                  onChange={(e) => setCustomPronunciationModelId(e.target.value)}
                />
              )}
              <p className="text-xs text-gray-400">
                Used only for pronunciation pre-scan and refinement. The smarter Flash model is recommended.
              </p>
            </div>

            <div className="space-y-3 md:col-span-2">
              <label className="block text-sm font-semibold">Profile Summary</label>
              <div className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 text-sm text-gray-600 dark:text-gray-300 space-y-1">
                <div><span className="font-medium text-gray-900 dark:text-gray-100">Profile id:</span> {selectedProfileId || 'unset'}</div>
                <div><span className="font-medium text-gray-900 dark:text-gray-100">Cleanup model:</span> {finalModel || 'unset'}</div>
                <div><span className="font-medium text-gray-900 dark:text-gray-100">Cleanup fallbacks:</span> {fallbackAiModels.map((model, index) => model === 'custom' ? customFallbackModelIds[index].trim() : model).filter(Boolean).join(' → ') || 'none'}</div>
                <div><span className="font-medium text-gray-900 dark:text-gray-100">Pronunciation model:</span> {finalPronunciationModel || 'unset'}</div>
                <div><span className="font-medium text-gray-900 dark:text-gray-100">Abbreviations:</span> {abbreviations.length}</div>
                <div><span className="font-medium text-gray-900 dark:text-gray-100">Pronunciations:</span> {pronunciations.length}</div>
                <div><span className="font-medium text-gray-900 dark:text-gray-100">Books:</span> {books.length}</div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <label className="block text-sm font-semibold">Prompt</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handlePromptModeChange('preset')}
                  className={`px-3 py-1.5 rounded border text-xs font-medium ${promptMode === 'preset' ? 'bg-accent text-background border-accent' : 'bg-surface text-foreground border-line hover:bg-accent-wash'}`}
                >
                  Choose template
                </button>
                <button
                  type="button"
                  onClick={() => handlePromptModeChange('custom')}
                  className={`px-3 py-1.5 rounded border text-xs font-medium ${promptMode === 'custom' ? 'bg-accent text-background border-accent' : 'bg-surface text-foreground border-line hover:bg-accent-wash'}`}
                >
                  Write custom
                </button>
              </div>
            </div>

            {promptMode === 'preset' ? (
              <div className="space-y-3">
                <select
                  className="w-full p-2 border rounded bg-surface-sunken dark:bg-gray-800 dark:border-gray-700 text-foreground cursor-pointer"
                  value={selectedPromptName}
                  onChange={(e) => handlePromptPresetChange(e.target.value)}
                >
                  {PRESET_PROMPTS.map((preset) => (
                    <option key={preset.name} value={preset.name}>{preset.name}</option>
                  ))}
                </select>
                <textarea
                  className="w-full h-44 p-3 border rounded bg-surface-sunken dark:bg-gray-800 dark:border-gray-700 text-foreground font-mono text-sm leading-relaxed"
                  value={prompt}
                  readOnly
                />
                <p className="text-xs text-soft">
                  Pick a template to start from. Switch to custom to edit the prompt by hand.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  className="w-full h-44 p-3 border rounded bg-surface-sunken dark:bg-gray-800 dark:border-gray-700 text-foreground font-mono text-sm leading-relaxed"
                  placeholder="Enter your specific formatting rules here..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <p className="text-xs text-soft">
                  This custom prompt will be saved in the selected profile.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="space-y-4 p-4 border rounded dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex flex-col gap-3 mb-2">
            <div>
              <h3 className="font-semibold text-lg">Abbreviations</h3>
              <p className="text-xs text-gray-500">Static text expansion.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => downloadCSV(abbreviations, 'abbreviations.csv')} className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-200">Export</button>
              <button onClick={() => setAbbreviations(BASE_ABBREVIATIONS.map(({ key, value }) => ({ key, value })))} className="text-xs bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 px-2 py-1 rounded cursor-pointer hover:bg-yellow-200">Reset</button>
              <label className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 px-2 py-1 rounded cursor-pointer hover:bg-gray-300 dark:hover:bg-gray-600">
                Import CSV
                <input type="file" accept=".csv" className="hidden" onChange={(e) => handleCSVUpload(e, abbreviations, setAbbreviations)} />
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <input type="text" placeholder="Short (e.g. NT)" className="w-1/2 p-2 text-sm border rounded bg-white dark:bg-gray-900 dark:border-gray-700 text-gray-900 dark:text-gray-100" value={newAbbrev.key} onChange={(e) => setNewAbbrev({ ...newAbbrev, key: e.target.value })} />
            <input type="text" placeholder="Expanded" className="w-1/2 p-2 text-sm border rounded bg-white dark:bg-gray-900 dark:border-gray-700 text-gray-900 dark:text-gray-100" value={newAbbrev.value} onChange={(e) => setNewAbbrev({ ...newAbbrev, value: e.target.value })} />
            <button onClick={handleAddAbbrev} className="px-3 bg-blue-600 hover:bg-blue-700 text-white rounded font-bold shadow-sm">+</button>
          </div>
          <ul className="space-y-2 mt-4 max-h-96 overflow-y-auto pr-2">
            {abbreviations.map((item, idx) => (
              <li key={`${item.key}-${idx}`} className="flex items-center gap-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 p-2 rounded shadow-sm">
                <input type="checkbox" checked={selectedAbbrevs.includes(idx)} onChange={(e) => {
                  if (e.target.checked) setSelectedAbbrevs([...selectedAbbrevs, idx]);
                  else setSelectedAbbrevs(selectedAbbrevs.filter((i) => i !== idx));
                }} />
                <span className="flex-1"><strong>{item.key}</strong> &rarr; {item.value}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-4">
            <button onClick={() => { setAbbreviations(abbreviations.filter((_, i) => !selectedAbbrevs.includes(i))); setSelectedAbbrevs([]); }} className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-bold">Delete Selected</button>
            <button
              onClick={() => {
                if (window.confirm(`Delete all ${abbreviations.length} abbreviations from this profile?`)) {
                  setAbbreviations([]);
                  setSelectedAbbrevs([]);
                  toast.success('Cleared all abbreviations. Save the profile to keep changes.');
                }
              }}
              className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-bold"
            >
              Delete All
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-2 rounded border border-line bg-surface p-3">
            <div>
              <h3 className="text-sm font-semibold">Gemini pronunciation guidance</h3>
              <p className="text-xs text-soft">
                The required Kokoro compatibility rules always apply. Customize only this profile&apos;s pronunciation style.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setPronunciationPromptMode('default')}
                className={`px-3 py-1.5 rounded border text-xs font-medium ${pronunciationPromptMode === 'default' ? 'bg-accent text-background border-accent' : 'bg-surface text-foreground border-line hover:bg-accent-wash'}`}
              >
                Use universal default
              </button>
              <button
                type="button"
                onClick={() => {
                  setPronunciationPromptMode('custom');
                  setCustomPronunciationPrompt((current) => current || DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE);
                }}
                className={`px-3 py-1.5 rounded border text-xs font-medium ${pronunciationPromptMode === 'custom' ? 'bg-accent text-background border-accent' : 'bg-surface text-foreground border-line hover:bg-accent-wash'}`}
              >
                Customize this profile
              </button>
            </div>
            <textarea
              value={pronunciationPromptMode === 'custom' ? customPronunciationPrompt : DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE}
              onChange={(event) => setCustomPronunciationPrompt(event.target.value)}
              readOnly={pronunciationPromptMode === 'default'}
              className="w-full h-40 p-3 border rounded bg-surface-sunken border-line text-foreground font-mono text-xs leading-relaxed"
              aria-label="Profile pronunciation guidance"
            />
            <p className="text-xs text-soft">
              {pronunciationPromptMode === 'default'
                ? 'This profile automatically receives future universal-default improvements.'
                : 'This custom guidance applies only to the selected profile. Compatibility exclusions remain enforced separately.'}
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 font-medium cursor-pointer">
            <input
              type="checkbox"
              checked
              disabled
              className="rounded border-gray-300 dark:border-gray-700 text-purple-600 focus:ring-purple-500"
            />
            Global library (always on; local entries override)
          </label>
          <button onClick={loadGlobalPronunciations} className="text-xs bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 px-2 py-1 rounded cursor-pointer hover:bg-purple-200 self-start">
            View Global Pronunciations
          </button>
          <PronunciationGuideManager
            key={selectedProfileId}
            guideName={`${profileName || 'OpenReader'} Pronunciation Guide`}
            items={pronunciations}
            onChange={setPronunciations}
          />
        </div>

        <div className="space-y-4 p-4 border rounded dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <div className="flex flex-col gap-3 mb-2">
            <div>
              <h3 className="font-semibold text-lg">Biblical Books</h3>
              <p className="text-xs text-gray-500">Structural expansion.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => downloadCSV(books, 'biblical_books.csv')} className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 px-2 py-1 rounded cursor-pointer hover:bg-blue-200">Export</button>
              <button onClick={() => setBooks(BASE_BOOKS.map(({ key, value }) => ({ key, value })))} className="text-xs bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 px-2 py-1 rounded cursor-pointer hover:bg-yellow-200">Reset</button>
              <label className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 px-2 py-1 rounded cursor-pointer hover:bg-gray-300 dark:hover:bg-gray-600">
                Import CSV
                <input type="file" accept=".csv" className="hidden" onChange={(e) => handleCSVUpload(e, books, setBooks)} />
              </label>
            </div>
          </div>
          <div className="flex gap-2">
            <input type="text" placeholder="Short (e.g. Gen)" className="w-1/2 p-2 text-sm border rounded bg-white dark:bg-gray-900 dark:border-gray-700 text-gray-900 dark:text-gray-100" value={newBook.key} onChange={(e) => setNewBook({ ...newBook, key: e.target.value })} />
            <input type="text" placeholder="Full" className="w-1/2 p-2 text-sm border rounded bg-white dark:bg-gray-900 dark:border-gray-700 text-gray-900 dark:text-gray-100" value={newBook.value} onChange={(e) => setNewBook({ ...newBook, value: e.target.value })} />
            <button onClick={handleAddBook} className="px-3 bg-green-600 hover:bg-green-700 text-white rounded font-bold shadow-sm">+</button>
          </div>
          <ul className="space-y-2 mt-4 max-h-96 overflow-y-auto pr-2">
            {books.map((item, idx) => (
              <li key={`${item.key}-${idx}`} className="flex items-center gap-3 text-sm bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 p-2 rounded shadow-sm">
                <input type="checkbox" checked={selectedBooks.includes(idx)} onChange={(e) => {
                  if (e.target.checked) setSelectedBooks([...selectedBooks, idx]);
                  else setSelectedBooks(selectedBooks.filter((i) => i !== idx));
                }} />
                <span className="flex-1"><strong>{item.key}</strong> &rarr; {item.value}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-4">
            <button onClick={() => { setBooks(books.filter((_, i) => !selectedBooks.includes(i))); setSelectedBooks([]); }} className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-bold">Delete Selected</button>
            <button
              onClick={() => {
                if (window.confirm(`Delete all ${books.length} biblical book mappings from this profile?`)) {
                  setBooks([]);
                  setSelectedBooks([]);
                  toast.success('Cleared all biblical book mappings. Save the profile to keep changes.');
                }
              }}
              className="text-xs text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 font-bold"
            >
              Delete All
            </button>
          </div>
        </div>
      </div>

      <div className="pt-4 border-t dark:border-gray-800 flex justify-end gap-3">
        <button onClick={loadProfiles} className="bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-900 dark:text-gray-100 font-bold py-2 px-6 rounded shadow border border-gray-200 dark:border-gray-700">
          Reload
        </button>
        <button onClick={() => void handleSave()} className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-6 rounded shadow">
          Save Profile
        </button>
      </div>

      {isGlobalModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-4xl flex flex-col max-h-[90vh]">
            <div className="p-4 border-b dark:border-gray-800 flex justify-between items-center gap-4">
              <div>
                <h3 className="text-lg font-bold">Global Pronunciations</h3>
                <p className="mt-1 text-xs text-soft">
                  The first choice is the global default used automatically. A pronunciation saved in a user profile overrides it.
                </p>
              </div>
              <button onClick={() => setIsGlobalModalOpen(false)} className="text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">✕</button>
            </div>

            {/* Language filter tabs */}
            {!isLoadingGlobal && globalPronunciations.length > 0 && (() => {
              const hasGreek = globalPronunciations.some((item) => /[\u0370-\u03FF\u1F00-\u1FFF]/u.test(item.key));
              const hasHebrew = globalPronunciations.some((item) => /[\u0590-\u05FF]/u.test(item.key));
              const hasLatin = globalPronunciations.some((item) => /[a-zA-Z]/u.test(item.key));
              const tabs: Array<{ id: 'all' | 'greek' | 'hebrew' | 'latin'; label: string }> = [
                { id: 'all', label: `All (${globalPronunciations.length})` },
                ...(hasGreek ? [{ id: 'greek' as const, label: 'Greek (Α α)' }] : []),
                ...(hasHebrew ? [{ id: 'hebrew' as const, label: 'Hebrew (א)' }] : []),
                ...(hasLatin ? [{ id: 'latin' as const, label: 'Latin (A a)' }] : []),
              ];
              return (
                <div className="px-4 pt-3 flex gap-2 flex-wrap border-b dark:border-gray-800 pb-2">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => { setGlobalLangFilter(tab.id); setGlobalAlphaFilter(null); }}
                      className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                        globalLangFilter === tab.id
                          ? 'bg-purple-600 text-white border-purple-600'
                          : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              );
            })()}

            <div className="p-4 overflow-y-auto flex-1">
              {isAdmin && (
                <div className="mb-4 rounded border border-blue-200 bg-blue-50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-blue-950 dark:text-blue-100">Common-English cleanup</p>
                      <p className="mt-1 text-xs text-blue-800 dark:text-blue-200">
                        Finds ordinary English words added automatically by earlier scans. Human-created and legacy entries are protected.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={isScanningCommonEnglish || isRemovingCommonEnglish}
                      onClick={() => void scanCommonEnglishPronunciations()}
                      className="rounded bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                    >
                      {isScanningCommonEnglish ? 'Scanning…' : 'Scan Regular English'}
                    </button>
                  </div>
                  {commonEnglishCandidates !== null && (
                    <div className="mt-3 border-t border-blue-200 pt-3 dark:border-blue-900">
                      {commonEnglishCandidates.length === 0 ? (
                        <p className="text-xs text-blue-800 dark:text-blue-200">No machine-generated common-English entries were found.</p>
                      ) : (
                        <>
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs text-blue-900 dark:text-blue-100">
                              Review {commonEnglishCandidates.length} matches. Higher frequency means more ordinary English.
                            </p>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => setSelectedCommonEnglishWords(
                                  commonEnglishCandidates.filter((candidate) => candidate.removable).map((candidate) => candidate.word),
                                )}
                                className="text-xs font-semibold text-blue-800 hover:underline dark:text-blue-200"
                              >
                                Select removable
                              </button>
                              <button
                                type="button"
                                onClick={() => setSelectedCommonEnglishWords([])}
                                className="text-xs font-semibold text-blue-800 hover:underline dark:text-blue-200"
                              >
                                Clear
                              </button>
                            </div>
                          </div>
                          <ul className="max-h-56 space-y-1 overflow-y-auto rounded border border-blue-200 bg-white p-2 dark:border-blue-900 dark:bg-gray-950">
                            {commonEnglishCandidates.map((candidate) => (
                              <li key={candidate.word}>
                                <label className={`flex items-start gap-2 rounded px-2 py-1 text-xs ${candidate.removable ? 'hover:bg-blue-50 dark:hover:bg-blue-950/40' : 'opacity-60'}`}>
                                  <input
                                    type="checkbox"
                                    disabled={!candidate.removable || isRemovingCommonEnglish}
                                    checked={selectedCommonEnglishWords.includes(candidate.word)}
                                    onChange={(event) => setSelectedCommonEnglishWords((current) => (
                                      event.target.checked
                                        ? [...new Set([...current, candidate.word])]
                                        : current.filter((word) => word !== candidate.word)
                                    ))}
                                    className="mt-0.5"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <strong>{candidate.word}</strong>
                                    <span className="ml-2 text-gray-500">English frequency {candidate.zipfFrequency.toFixed(2)}</span>
                                    <span className="block truncate font-mono text-[10px] text-gray-500">{candidate.choices.join(' · ')}</span>
                                    {!candidate.removable && (
                                      <span className="block text-amber-700 dark:text-amber-300">Protected: contains {candidate.protectedChoices} human or legacy choice.</span>
                                    )}
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                          <div className="mt-3 flex justify-end">
                            <button
                              type="button"
                              disabled={selectedCommonEnglishWords.length === 0 || isRemovingCommonEnglish}
                              onClick={() => void removeSelectedCommonEnglishPronunciations()}
                              className="rounded bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                            >
                              {isRemovingCommonEnglish ? 'Removing…' : `Remove Selected (${selectedCommonEnglishWords.length})`}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {!isLoadingGlobal && globalPronunciations.length > 0 && (
                <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-900 dark:text-amber-100"
                      onClick={() => setShowSuspectPronunciationsOnly((current) => !current)}
                    >
                      {showSuspectPronunciationsOnly ? 'Show All' : `Show ${suspectWordCount} Suspect`}
                    </button>
                    <button
                      type="button"
                      className="rounded bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
                      disabled={suspectWordCount === 0 || isRescanningSuspects}
                      onClick={() => void handleRescanSuspectPronunciations()}
                    >
                      {isRescanningSuspects ? 'Rescanning…' : 'Force Rescan Suspects'}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
                    Found {suspectGlobalWords.length} global and {suspectPersonalWords.length} personal/profile suspect entries. Detection includes LitRPG names and flags malformed IPA or patterns such as adjacent /y/ and /j/ that Kokoro may spell aloud.
                  </p>
                </div>
              )}
              {!isLoadingGlobal && suspectPersonalPronunciations.length > 0 && (
                <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                  <p className="mb-2 text-xs font-semibold text-amber-900 dark:text-amber-100">
                    Personal pronunciations in {profileName || 'the selected profile'}
                  </p>
                  <ul className="space-y-2">
                    {suspectPersonalPronunciations.map((item) => (
                      <li key={item.key} className="text-xs text-amber-800 dark:text-amber-200">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong>{item.key}</strong>: <code>{item.value}</code>
                          {getKokoroPronunciationQualityWarnings(item.key, item.value).map((warning) => (
                            <span key={warning}>— {warning}</span>
                          ))}
                          <button
                            type="button"
                            onClick={() => {
                              setEditingPersonalSuspect(item.key);
                              setPersonalSuspectEditValue(item.value);
                            }}
                            className="rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 dark:bg-gray-900 dark:text-amber-100"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={isSavingPersonalSuspect}
                            onClick={() => {
                              if (window.confirm(`Remove the personal override for ${item.key}? The global pronunciation will apply when one exists.`)) {
                                void savePersonalSuspectPronunciation(item.key, null);
                              }
                            }}
                            className="rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:bg-gray-900 dark:text-amber-100"
                          >
                            Use Global
                          </button>
                        </div>
                        {editingPersonalSuspect === item.key && (
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <input
                              value={personalSuspectEditValue}
                              onChange={(event) => setPersonalSuspectEditValue(event.target.value)}
                              className="min-w-64 flex-1 rounded border border-amber-400 bg-white px-2 py-1 font-mono text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100"
                              aria-label={`Personal pronunciation for ${item.key}`}
                            />
                            <button
                              type="button"
                              disabled={isSavingPersonalSuspect}
                              onClick={() => void savePersonalSuspectPronunciation(item.key, personalSuspectEditValue)}
                              className="rounded bg-amber-700 px-2 py-1 text-[11px] font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
                            >
                              {isSavingPersonalSuspect ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              disabled={isSavingPersonalSuspect}
                              onClick={() => setEditingPersonalSuspect(null)}
                              className="text-[11px] font-semibold hover:underline disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {isLoadingGlobal ? (
                <div className="flex justify-center p-8"><span className="text-gray-500">Loading...</span></div>
              ) : globalPronunciations.length === 0 ? (
                <div className="text-center p-8 text-gray-500">No global pronunciations found.</div>
              ) : (() => {
                // Filter by language script
                const langFiltered = globalPronunciations
                  .filter((item) => !showSuspectPronunciationsOnly || suspectGlobalWords.includes(item.key))
                  .filter((item) => {
                    if (globalLangFilter === 'greek') return /[\u0370-\u03FF\u1F00-\u1FFF]/u.test(item.key);
                    if (globalLangFilter === 'hebrew') return /[\u0590-\u05FF]/u.test(item.key);
                    if (globalLangFilter === 'latin') return /[a-zA-Z]/u.test(item.key) && !/[\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF]/u.test(item.key);
                    return true;
                  });

                // Build alphabet index from the filtered list
                const getAlphaKey = (word: string): string => {
                  // Normalize to NFC so accented Greek is treated as a letter
                  const first = word.normalize('NFC')[0] ?? '#';
                  // For Hebrew, map to canonical block first char
                  if (/[\u0590-\u05FF]/u.test(first)) return first;
                  // For Greek, uppercase canonical
                  if (/[\u0370-\u03FF\u1F00-\u1FFF]/u.test(first)) return first.toLocaleUpperCase('el');
                  // Latin uppercase
                  if (/[a-zA-Z]/u.test(first)) return first.toUpperCase();
                  return '#';
                };

                const alphaKeys = [...new Set(langFiltered.map((item) => getAlphaKey(item.key)))].sort(
                  (a, b) => a.localeCompare(b, 'und', { sensitivity: 'base' })
                );

                const alphaFiltered = globalAlphaFilter
                  ? langFiltered.filter((item) => getAlphaKey(item.key) === globalAlphaFilter)
                  : langFiltered;

                return (
                  <>
                    {/* Alphabet index bar */}
                    {alphaKeys.length > 1 && (
                      <div className="mb-4 flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => setGlobalAlphaFilter(null)}
                          className={`rounded px-2 py-0.5 text-xs font-bold border ${
                            globalAlphaFilter === null
                              ? 'bg-purple-600 text-white border-purple-600'
                              : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                          }`}
                        >
                          All
                        </button>
                        {alphaKeys.map((letter) => (
                          <button
                            key={letter}
                            type="button"
                            onClick={() => setGlobalAlphaFilter(letter === globalAlphaFilter ? null : letter)}
                            className={`rounded px-2 py-0.5 text-xs font-bold border ${
                              globalAlphaFilter === letter
                                ? 'bg-purple-600 text-white border-purple-600'
                                : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                            }`}
                          >
                            {letter}
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="mb-2 text-xs text-soft">{alphaFiltered.length} word{alphaFiltered.length !== 1 ? 's' : ''}</p>
                    <ul className="space-y-3">
                      {alphaFiltered.map((item) => (
                        <li key={item.key} className="flex flex-col gap-2 bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <strong className="block text-sm">{item.key}</strong>
                            {isAdmin && (
                              <button
                                type="button"
                                onClick={() => void handleDeleteGlobalWord(item.key)}
                                className="rounded bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700"
                              >
                                Delete Word from Global Library
                              </button>
                            )}
                          </div>
                          <div className="flex flex-col gap-2">
                            {item.values.map((phonetic, idx) => {
                              const warnings = getKokoroPronunciationQualityWarnings(item.key, phonetic);
                              const compositeKey = `${item.key}::${phonetic}`;
                              return (
                              <div key={idx} className={`flex flex-wrap items-center gap-3 p-2 rounded border ${warnings.length > 0 ? 'border-amber-400 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30' : idx === 0 ? 'border-green-500 bg-green-50 dark:border-green-800 dark:bg-green-950/30' : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'}`}>
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <code className="text-xs text-purple-600 dark:text-purple-400">{phonetic}</code>
                                    {idx === 0 && (
                                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-800 dark:bg-green-900 dark:text-green-100">
                                        Global default
                                      </span>
                                    )}
                                  </div>
                                  {warnings.map((warning) => (
                                    <p key={warning} className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">{warning}</p>
                                  ))}
                                </div>
                                <button
                                  onClick={() => void playPreview(item.key, phonetic)}
                                  disabled={playingKey === compositeKey}
                                  className="px-2 py-1 bg-blue-100 dark:bg-blue-900/50 hover:bg-blue-200 dark:hover:bg-blue-900 text-blue-700 dark:text-blue-300 rounded text-xs font-semibold disabled:opacity-50"
                                >
                                  {playingKey === compositeKey ? 'Playing...' : 'Listen'}
                                </button>
                                <button
                                  onClick={() => handleAdoptGlobal(item.key, phonetic)}
                                  className="px-2 py-1 bg-green-100 dark:bg-green-900/50 hover:bg-green-200 dark:hover:bg-green-900 text-green-700 dark:text-green-300 rounded text-xs font-semibold"
                                >
                                  Adopt to My Profile
                                </button>
                                {isAdmin && idx !== 0 && (
                                  <button
                                    type="button"
                                    onClick={() => void handleSetGlobalDefault(item.key, phonetic)}
                                    className="rounded bg-green-600 px-2 py-1 text-xs font-semibold text-white hover:bg-green-700"
                                  >
                                    Make Global Default
                                  </button>
                                )}
                                {isAdmin && (
                                  <button
                                    type="button"
                                    onClick={() => void handleDeleteGlobalChoice(item.key, phonetic)}
                                    className="rounded bg-red-100 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-200 dark:bg-red-950/40 dark:text-red-300"
                                  >
                                    Remove Choice
                                  </button>
                                )}
                              </div>
                              );
                            })}
                          </div>
                          {isAdmin && (
                            <div className="rounded border border-purple-300 bg-purple-50 p-3 dark:border-purple-800 dark:bg-purple-950/30">
                              <label className="block text-xs font-semibold text-purple-900 dark:text-purple-100" htmlFor={`global-ai-guidance-${item.key}`}>
                                Administrator AI pronunciation guidance
                              </label>
                              <textarea
                                id={`global-ai-guidance-${item.key}`}
                                value={globalRefineInput[item.key] || ''}
                                onChange={(event) => setGlobalRefineInput((current) => ({
                                  ...current,
                                  [item.key]: event.target.value,
                                }))}
                                placeholder="Describe how it should sound, the pronunciation tradition, or an English approximation."
                                className="mt-2 min-h-20 w-full rounded border border-purple-200 bg-white p-2 text-xs text-gray-900 dark:border-purple-800 dark:bg-gray-900 dark:text-gray-100"
                              />
                              <button
                                type="button"
                                onClick={() => void handleRefineGlobal(item.key, item.values)}
                                disabled={Boolean(globalRefineStatus[item.key])}
                                className="mt-2 rounded bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 disabled:opacity-50"
                              >
                                {globalRefineStatus[item.key] || 'Ask AI for 5 Replacement Choices'}
                              </button>
                              {(globalRefineChoices[item.key] || []).length > 0 && (
                                <div className="mt-3 space-y-2">
                                  <p className="text-xs text-purple-900 dark:text-purple-100">
                                    Review the generated choices and select which one should become the global default.
                                  </p>
                                  {(globalRefineChoices[item.key] || []).map((choice, choiceIndex) => {
                                    const warnings = getKokoroPronunciationQualityWarnings(item.key, choice);
                                    return (
                                      <label
                                        key={choice}
                                        className={`flex flex-wrap items-center gap-2 rounded border p-2 text-xs ${warnings.length > 0 ? 'border-amber-400 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30' : 'border-purple-200 bg-white dark:border-purple-800 dark:bg-gray-900'}`}
                                      >
                                        <input
                                          type="radio"
                                          name={`global-default-${item.key}`}
                                          checked={(globalRefineDefault[item.key] || 0) === choiceIndex}
                                          onChange={() => setGlobalRefineDefault((current) => ({
                                            ...current,
                                            [item.key]: choiceIndex,
                                          }))}
                                        />
                                        <code className="min-w-0 flex-1 [overflow-wrap:anywhere]">{choice}</code>
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.preventDefault();
                                            void playPreview(item.key, choice);
                                          }}
                                          className="rounded bg-blue-100 px-2 py-1 font-semibold text-blue-700 hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300"
                                        >
                                          Listen
                                        </button>
                                        {warnings.map((warning) => (
                                          <span key={warning} className="w-full text-[10px] text-amber-700 dark:text-amber-300">{warning}</span>
                                        ))}
                                      </label>
                                    );
                                  })}
                                  <button
                                    type="button"
                                    onClick={() => void handleApplyGlobalChoices(item.key)}
                                    disabled={(globalRefineChoices[item.key] || []).some(
                                      (choice) => getKokoroPronunciationQualityWarnings(item.key, choice).length > 0,
                                    )}
                                    className="rounded bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    Apply Reviewed Choices Globally
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                );
              })()}
            </div>
            <div className="p-4 border-t dark:border-gray-800 flex justify-end">
              <button onClick={() => setIsGlobalModalOpen(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-800 rounded font-semibold text-sm">Close</button>
            </div>
          </div>
        </div>
      )}
      {isWizardOpen && (
        <SmartAudioWizardModal
          isOpen={isWizardOpen}
          onClose={() => setIsWizardOpen(false)}
          currentApiKey={apiKey}
          currentApiKeyConfigured={Boolean(activeProfile?.geminiApiKeyConfigured)}
          onSaveUniversalSetup={handleSaveUniversalSetup}
        />
      )}
      <ScanForeignWordsModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
      />
      <BookPronunciationInspectorModal
        isOpen={isInspectorOpen}
        onClose={() => setIsInspectorOpen(false)}
      />
    </div>
  );
}

export default SmartAudioSettings;
