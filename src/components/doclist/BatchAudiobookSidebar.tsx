'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ReaderSidebarShell } from '@/components/reader/ReaderSidebarShell';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useConfig } from '@/contexts/ConfigContext';
import { VoicesControlBase } from '@/components/player/VoicesControlBase';
import { MultiVoiceCharacterModal } from '@/components/doclist/MultiVoiceCharacterModal';
import { Button, Select, Card } from '@/components/ui';
import { getVoices } from '@/lib/client/api/audiobooks';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import {
  getNarratorVoiceId,
  MULTI_VOICE_WORKER_MODE,
  DRAMA_GEMINI_TTS_WORKER_MODE,
} from '@/lib/shared/multi-voice';
import {
  CLOUD_TTS_CHARACTER_VOICE_SET,
  CLOUD_TTS_FEMALE_VOICES,
  CLOUD_TTS_MODEL,
} from '@/lib/shared/google-cloud-tts-voices';
import {
  AUDIOBOOK_QUOTA_UPDATED_EVENT,
  formatMonthlyAudiobookQuotaMessage,
  isMonthlyAudiobookQuotaProblem,
} from '@/lib/shared/audiobook-quota';
import type { TTSAudiobookFormat } from '@/types/tts';
import type { DocumentListDocument } from '@/types/documents';
import type { SmartAudioProfile } from '@/types/client';
import type { SmartAudioCharacterMap } from '@/types/document-settings';

interface BatchAudiobookSidebarProps {
  isOpen: boolean;
  setIsOpen: (isOpen: boolean) => void;
  selectedDocs: DocumentListDocument[];
}

export function BatchAudiobookSidebar({ isOpen, setIsOpen, selectedDocs }: BatchAudiobookSidebarProps) {
  const router = useRouter();
  const {
    providerType,
    ttsModel,
    apiKey,
    baseUrl,
    providerRef,
    voiceSpeed,
    audioPlayerSpeed,
    smartAudioProfileId,
    voice: configVoice,
  } = useConfig();

  // ── Voice state ──────────────────────────────────────────────────────────
  const [availableVoices, setAvailableVoices] = useState<string[]>([]);
  const [audiobookVoice, setAudiobookVoice] = useState<string>(configVoice || '');
  const [isFetchingVoices, setIsFetchingVoices] = useState(false);

  const providerModelPolicy = resolveTtsProviderModelPolicy({ providerRef, providerType, model: ttsModel });

  const fetchVoices = useCallback(async () => {
    setIsFetchingVoices(true);
    try {
      const data = await getVoices({
        'x-openai-key': apiKey || '',
        'x-openai-base-url': baseUrl || '',
        'x-tts-provider': providerRef || 'openai',
        'x-tts-model': ttsModel || 'tts-1',
        'Content-Type': 'application/json',
      });
      const voices =
        data.voices && data.voices.length > 0
          ? data.voices
          : providerModelPolicy.defaultVoices;
      setAvailableVoices(voices);
      // Only set default voice if we don't have one yet
      setAudiobookVoice((prev) => (prev && voices.includes(prev) ? prev : voices[0] || ''));
    } catch {
      const fallback = providerModelPolicy.defaultVoices;
      setAvailableVoices(fallback);
      setAudiobookVoice((prev) => (prev && fallback.includes(prev) ? prev : fallback[0] || ''));
    } finally {
      setIsFetchingVoices(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, baseUrl, providerRef, ttsModel]);

  // Fetch voices whenever the sidebar opens
  useEffect(() => {
    if (isOpen) {
      void fetchVoices();
    }
  }, [isOpen, fetchVoices]);

  // ── Format ───────────────────────────────────────────────────────────────
  const [audiobookFormat, setAudiobookFormat] = useState<TTSAudiobookFormat>('m4b');

  // ── Smart AI ─────────────────────────────────────────────────────────────
  const [useSmartAudio, setUseSmartAudio] = useState(false);
  const [useScholarDefinitions, setUseScholarDefinitions] = useState(true);
  const [smartAudioProfiles, setSmartAudioProfiles] = useState<SmartAudioProfile[]>([]);
  const [selectedSmartAudioProfileId, setSelectedSmartAudioProfileId] = useState(smartAudioProfileId || '');
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);

  // Load profiles as soon as the sidebar mounts (not just when it opens),
  // so they are ready when the user clicks the Smart AI toggle.
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setIsLoadingProfiles(true);
      try {
        const res = await fetch('/api/tts-settings', { signal: controller.signal });
        if (!res.ok) {
          console.warn('tts-settings returned', res.status, res.statusText);
          return;
        }
        const data = await res.json();
        console.log('[BatchAudiobookSidebar] tts-settings response:', data);
        const profiles: SmartAudioProfile[] = Array.isArray(data.smartAudioProfiles) ? data.smartAudioProfiles : [];
        setSmartAudioProfiles(profiles);
        const preferred = typeof data.selectedSmartAudioProfileId === 'string' && data.selectedSmartAudioProfileId
          ? data.selectedSmartAudioProfileId
          : smartAudioProfileId;
        const next = profiles.some((p) => p.id === preferred) ? preferred : profiles[0]?.id || '';
        setSelectedSmartAudioProfileId(next || '');
        const profile = profiles.find((p) => p.id === next);
        if (profile?.workerMode === MULTI_VOICE_WORKER_MODE || profile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
          setUseSmartAudio(true);
        }
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        console.warn('[BatchAudiobookSidebar] Failed to load smart audio profiles:', err);
      } finally {
        setIsLoadingProfiles(false);
      }
    };

    void load();

    const handleUpdate = () => {
      void load();
    };
    window.addEventListener('smart-audio-profiles-updated', handleUpdate);

    return () => {
      controller.abort();
      window.removeEventListener('smart-audio-profiles-updated', handleUpdate);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedSmartAudioProfile = smartAudioProfiles.find((p) => p.id === selectedSmartAudioProfileId) || smartAudioProfiles[0] || null;
  const isCloudDrama = selectedSmartAudioProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE;
  const isDramaProfile = useSmartAudio
    && (selectedSmartAudioProfile?.workerMode === MULTI_VOICE_WORKER_MODE || isCloudDrama);
  const [dramaNarratorVoices, setDramaNarratorVoices] = useState<Record<string, string | null>>({});
  const [isLoadingDramaNarrators, setIsLoadingDramaNarrators] = useState(false);

  useEffect(() => {
    if (!isOpen || !isDramaProfile || !selectedSmartAudioProfileId || selectedDocs.length === 0) {
      setDramaNarratorVoices({});
      setIsLoadingDramaNarrators(false);
      return;
    }
    const controller = new AbortController();
    setIsLoadingDramaNarrators(true);
    void Promise.all(selectedDocs.map(async (doc) => {
      const response = await fetch(`/api/audiobook/characters/scan?documentId=${encodeURIComponent(doc.id)}&profileId=${encodeURIComponent(selectedSmartAudioProfileId)}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return [doc.id, null] as const;
      const body = await response.json().catch(() => ({}));
      return [doc.id, getNarratorVoiceId(body.characterMap, isCloudDrama ? { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET } : {})] as const;
    })).then((entries) => {
      if (!controller.signal.aborted) setDramaNarratorVoices(Object.fromEntries(entries));
    }).catch((error) => {
      if ((error as Error)?.name !== 'AbortError') setDramaNarratorVoices({});
    }).finally(() => {
      if (!controller.signal.aborted) setIsLoadingDramaNarrators(false);
    });
    return () => controller.abort();
  }, [isCloudDrama, isDramaProfile, isOpen, selectedDocs, selectedSmartAudioProfileId]);

  // ── Queueing ─────────────────────────────────────────────────────────────
  const [isQueueing, setIsQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [showScholarScanWarning, setShowScholarScanWarning] = useState(false);
  const [showDramaReplacementWarning, setShowDramaReplacementWarning] = useState(false);
  const [pendingCharacterDoc, setPendingCharacterDoc] = useState<DocumentListDocument | null>(null);
  const [pendingBatchScholarConfirm, setPendingBatchScholarConfirm] = useState(false);

  const handleStartBatch = async (
    confirmScholarAutoScan = false,
    narratorOverrides: Record<string, string | null> = {},
    confirmReplaceExisting = false,
  ) => {
    if (selectedDocs.length === 0) return;
    setIsQueueing(true);
    setQueueError(null);
    setQueuedCount(0);
    try {
      const settingsFor = (documentId: string) => ({
        voice: isDramaProfile
          ? narratorOverrides[documentId] || dramaNarratorVoices[documentId] || (isCloudDrama ? (CLOUD_TTS_FEMALE_VOICES[0] || 'en-US-Journey-F') : audiobookVoice)
          : audiobookVoice,
        format: audiobookFormat,
        providerRef: isCloudDrama ? 'google-cloud' : (providerRef || ''),
        providerType: isCloudDrama ? 'google-cloud' : providerType,
        ttsModel: isCloudDrama ? CLOUD_TTS_MODEL : ttsModel,
        nativeSpeed: voiceSpeed || 1,
        postSpeed: audioPlayerSpeed || 1,
        useSmartAudio,
        smartAudioProfileId: useSmartAudio ? selectedSmartAudioProfileId : undefined,
        scholarIncludeDefinitions: useScholarDefinitions,
      });

      if (!confirmScholarAutoScan) {
        for (const doc of selectedDocs) {
          const preflight = await fetch('/api/audiobooks/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              documentId: doc.id,
              settings: settingsFor(doc.id),
              preflightOnly: true,
              confirmReplaceExisting,
            }),
          });
          const preflightBody = await preflight.json().catch(() => null);
          if (preflight.status === 409 && preflightBody?.code === 'SCHOLAR_SCAN_REQUIRED') {
            setShowScholarScanWarning(true);
            return;
          }
          if (preflight.status === 409 && preflightBody?.code === 'CHARACTER_CAST_REQUIRED') {
            setPendingBatchScholarConfirm(confirmScholarAutoScan);
            setPendingCharacterDoc(doc);
            return;
          }
          if (preflight.status === 409 && preflightBody?.code === 'AUDIOBOOK_REPLACEMENT_REQUIRED') {
            setPendingBatchScholarConfirm(confirmScholarAutoScan);
            setShowDramaReplacementWarning(true);
            return;
          }
          if (!preflight.ok) {
            throw new Error(preflightBody?.error || `Failed to check ${doc.name}`);
          }
        }
      }

      let count = 0;
      for (const doc of selectedDocs) {
        const res = await fetch('/api/audiobooks/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId: doc.id,
            settings: settingsFor(doc.id),
            confirmScholarAutoScan,
            confirmReplaceExisting,
          }),
        });
        const responseBody = await res.json().catch(() => null);
        if (res.status === 409 && responseBody?.code === 'SCHOLAR_SCAN_REQUIRED') {
          setQueuedCount(count);
          setShowScholarScanWarning(true);
          return;
        }
        if (res.status === 409 && responseBody?.code === 'CHARACTER_CAST_REQUIRED') {
          setQueuedCount(count);
          setPendingBatchScholarConfirm(confirmScholarAutoScan);
          setPendingCharacterDoc(doc);
          return;
        }
        if (res.status === 409 && responseBody?.code === 'AUDIOBOOK_REPLACEMENT_REQUIRED') {
          setQueuedCount(count);
          setPendingBatchScholarConfirm(confirmScholarAutoScan);
          setShowDramaReplacementWarning(true);
          return;
        }
        if (!res.ok) {
          if (res.status === 429 && isMonthlyAudiobookQuotaProblem(responseBody)) {
            throw new Error(formatMonthlyAudiobookQuotaMessage(responseBody));
          }
          throw new Error(responseBody?.error || `Failed to queue ${doc.name}`);
        }
        window.dispatchEvent(new Event(AUDIOBOOK_QUOTA_UPDATED_EVENT));
        count++;
      }
      setQueuedCount(count);
      setIsOpen(false);
      router.refresh();
    } catch (e) {
      console.error(e);
      setQueueError(e instanceof Error ? e.message : 'Failed to enqueue some audiobooks. Please try again.');
    } finally {
      setIsQueueing(false);
    }
  };

  const providerLabel = providerRef || 'Default (from Admin Settings)';

  return (
    <ReaderSidebarShell
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      ariaLabel="Batch Export Audiobooks"
      title="Batch Export"
      subtitle={`Generate audiobooks for ${selectedDocs.length} document${selectedDocs.length !== 1 ? 's' : ''}.`}
    >
      <div className="p-4 space-y-4 overflow-y-auto">

        {/* Provider info card */}
        <div className="rounded-lg bg-surface-raised border border-line px-3 py-2.5 space-y-0.5">
          <p className="text-[11px] uppercase tracking-wider font-medium text-soft">TTS Provider</p>
          <p className="text-sm text-primary truncate">
            {isDramaProfile && isCloudDrama
              ? 'Google Cloud Gemini-TTS'
              : providerLabel}
          </p>
          {(isDramaProfile && isCloudDrama ? CLOUD_TTS_MODEL : ttsModel) && (
            <p className="text-xs text-soft">
              Model: {isDramaProfile && isCloudDrama ? CLOUD_TTS_MODEL : ttsModel}
            </p>
          )}
          <p className="text-[11px] text-soft mt-1">
            {isDramaProfile && isCloudDrama
              ? 'Multi-character drama managed by Google Cloud & Gemini Director.'
              : 'Change provider in Settings to switch.'}
          </p>
        </div>

        {/* Voice picker */}
        {!isDramaProfile && <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-wider font-medium text-soft">
            Voice {isFetchingVoices && <span className="text-soft normal-case">(loading…)</span>}
          </label>
          <VoicesControlBase
            availableVoices={availableVoices}
            voice={audiobookVoice}
            onChangeVoice={setAudiobookVoice}
            providerType={providerType}
            ttsModel={ttsModel}
            dropdownDirection="down"
            variant="field"
          />
          {!isFetchingVoices && availableVoices.length === 0 && (
            <p className="text-xs text-soft italic">
              No voices found. Make sure a TTS provider is configured in Settings.
            </p>
          )}
        </div>}

        {/* Format picker */}
        <div className="space-y-1.5">
          <label className="text-[11px] uppercase tracking-wider font-medium text-soft">Format</label>
          <Select
            value={audiobookFormat}
            options={['m4b', 'mp3'] as TTSAudiobookFormat[]}
            renderValue={(v) => (v === 'm4b' ? 'M4B (Apple Books)' : 'MP3 (Universal)')}
            renderOption={(v) => (v === 'm4b' ? 'M4B (Apple Books)' : 'MP3 (Universal)')}
            onChange={(v) => setAudiobookFormat(v)}
          />
        </div>

        {/* Smart AI Toggle */}
        <Card className="p-3">
          <label className="flex items-center justify-between cursor-pointer">
            <div className="space-y-0.5 pr-4">
              <span className="text-sm font-medium text-foreground">Smart AI Formatting</span>
              <p className="text-xs text-soft">
                Use AI to process footnotes, apply phonetics, and fix layout artifacts before TTS generation.
              </p>
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
              />
              <div className="h-6 w-11 rounded-full bg-surface-sunken border border-line peer-checked:bg-accent peer-checked:border-accent after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-full" />
            </div>
          </label>
        </Card>

        {/* Smart AI Profile picker (shown only when enabled) */}
        {useSmartAudio && (
          <Card className="p-3">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-foreground">Smart AI Profile</label>
              {isLoadingProfiles ? (
                <p className="text-xs text-soft italic">Loading profiles…</p>
              ) : smartAudioProfiles.length === 0 ? (
                <p className="text-xs text-soft italic">
                  No smart AI profiles found. Create one in{' '}
                  <span className="underline">Settings → Smart AI</span>.
                </p>
              ) : (
                <>
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
                      setSelectedSmartAudioProfileId(newProfileId);
                      if (newProfile?.workerMode === MULTI_VOICE_WORKER_MODE || newProfile?.workerMode === DRAMA_GEMINI_TTS_WORKER_MODE) {
                        setUseSmartAudio(true);
                      }
                    }}
                  >
                    {smartAudioProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                  {selectedSmartAudioProfile && (
                    <div className="text-xs text-soft">
                      <p>Pronunciation: {selectedSmartAudioProfile.pronunciationAiModel || selectedSmartAudioProfile.aiModel}</p>
                      <p>Cleanup: {[selectedSmartAudioProfile.aiModel, ...(selectedSmartAudioProfile.aiModelFallbacks || [])].join(' → ')} · {Object.keys(selectedSmartAudioProfile.abbreviations || {}).length} abbreviations · {Object.keys(selectedSmartAudioProfile.pronunciations || {}).length} pronunciations</p>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>
        )}

        {isDramaProfile && (
          <div className="rounded-lg border border-accent bg-accent-wash p-3 space-y-2" role="status">
            <div>
              <p className="text-sm font-medium text-foreground">
                {isCloudDrama ? 'Google Cloud · Audio Drama · Multiple voices' : 'Audio Drama · Multiple voices'}
              </p>
              <p className="text-xs text-soft">
                {isCloudDrama
                  ? 'Narration and character dialogue use Google Cloud Gemini-TTS voices from that book’s reviewed cast. Books without a completed cast will prompt for cast assignment before queueing.'
                  : 'Narration and each character use the voices from that book’s reviewed cast. Books without a completed cast will pause for review before they are queued.'}
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wider font-medium text-soft">Narrator Voice</p>
              {selectedDocs.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate text-primary">{doc.name}</span>
                  <span className="shrink-0 font-medium text-foreground">
                    {isLoadingDramaNarrators ? 'Loading…' : dramaNarratorVoices[doc.id] || 'Not assigned yet'}
                  </span>
                </div>
              ))}
            </div>
          </div>
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
                <p className="text-xs text-soft">
                  Insert cached contextual English definitions inline next to isolated foreign-language terms before the Gemini cleanup pass. Disable to get IPA pronunciation markup only.
                </p>
              </div>
              <div className="relative inline-flex items-center shrink-0">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={useScholarDefinitions}
                  onChange={(e) => setUseScholarDefinitions(e.target.checked)}
                />
                <div className="h-6 w-11 rounded-full bg-surface-sunken border border-line peer-checked:bg-danger peer-checked:border-danger after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-surface after:transition-transform peer-checked:after:translate-x-full" />
              </div>
            </label>
          </div>
        )}

        {/* Selected documents preview */}
        {selectedDocs.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[11px] uppercase tracking-wider font-medium text-soft">
              Queued Documents ({selectedDocs.length})
            </p>
            <div className="rounded-lg border border-line bg-surface-sunken max-h-40 overflow-y-auto divide-y divide-line">
              {selectedDocs.map((doc) => (
                <div key={doc.id} className="px-3 py-2 text-sm text-primary truncate">
                  {doc.name}
                </div>
              ))}
            </div>
          </div>
        )}

        {queueError && (
          <p className="text-xs text-destructive">{queueError}</p>
        )}

        {/* Action */}
        <div className="space-y-2 pt-1">
          <Button
            className="w-full"
            variant="primary"
            onClick={() => void handleStartBatch()}
            disabled={isQueueing || selectedDocs.length === 0 || (!isCloudDrama && availableVoices.length === 0)}
          >
            {isQueueing
              ? `Queueing ${selectedDocs.length} book${selectedDocs.length !== 1 ? 's' : ''}…`
              : isDramaProfile
                ? isCloudDrama
                  ? `Generate Google Cloud Drama Audiobook${selectedDocs.length > 1 ? 's' : ''}`
                  : `Generate Audio Drama Audiobook${selectedDocs.length > 1 ? 's' : ''}`
                : `Queue ${selectedDocs.length} Audiobook${selectedDocs.length !== 1 ? 's' : ''}`}
          </Button>
          <p className="text-[11px] text-soft text-center">
            Generation runs on the server — safe to close your browser.
          </p>
        </div>

        {queuedCount > 0 && (
          <p className="text-xs text-success text-center">
            ✓ {queuedCount} job{queuedCount !== 1 ? 's' : ''} added to the queue.
          </p>
        )}
      </div>
      <ConfirmDialog
        isOpen={showDramaReplacementWarning}
        onClose={() => setShowDramaReplacementWarning(false)}
        onConfirm={() => {
          setShowDramaReplacementWarning(false);
          void handleStartBatch(pendingBatchScholarConfirm, {}, true);
        }}
        title="Replace Existing Audiobook?"
        message="At least one selected document already has a regular audiobook. Converting to Audio Drama will permanently delete every existing generated chapter and combined audiobook file for each affected document, then regenerate them with the reviewed narrator and character voices."
        confirmText="Replace & Regenerate"
        cancelText="Keep Existing Audiobook"
        isDangerous={true}
      />
      <ConfirmDialog
        isOpen={showScholarScanWarning}
        onClose={() => setShowScholarScanWarning(false)}
        onConfirm={() => {
          setShowScholarScanWarning(false);
          void handleStartBatch(true);
        }}
        title="Pronunciation & Definition Scan Needed"
        message="At least one selected book has not completed a pronunciation and definition scan. We recommend reviewing pronunciations first. If you continue, OpenReader will auto-scan each unresolved book, adopt Gemini’s recommended pronunciations, and cache short English definitions."
        confirmText="Continue & Auto-Scan"
        cancelText="Review First"
        isDangerous={false}
      />
      {pendingCharacterDoc && selectedSmartAudioProfileId && (
        <MultiVoiceCharacterModal
          documentId={pendingCharacterDoc.id}
          profileId={selectedSmartAudioProfileId}
          workerMode={isCloudDrama ? 'drama-gemini-tts' : 'multi-voice'}
          isOpen={true}
          onClose={() => setPendingCharacterDoc(null)}
          onComplete={async (savedCharacterMap: SmartAudioCharacterMap) => {
            const documentId = pendingCharacterDoc.id;
            const narratorVoice = getNarratorVoiceId(savedCharacterMap, isCloudDrama ? { validVoiceSet: CLOUD_TTS_CHARACTER_VOICE_SET } : {});
            setDramaNarratorVoices((current) => ({ ...current, [documentId]: narratorVoice }));
            setPendingCharacterDoc(null);
            await handleStartBatch(pendingBatchScholarConfirm, { [documentId]: narratorVoice });
          }}
        />
      )}
    </ReaderSidebarShell>
  );
}
