'use client';

import { useEffect, useRef, useState } from 'react';
import { getMatchingDramaSpeakerReview } from '@/lib/shared/drama-speaker-review';
import type { DramaSpeakerReview, DramaSpeakerReviewTurn } from '@/lib/shared/drama-speaker-review';
import { DRAMA_UTTERANCE_TYPES } from '@/lib/shared/drama-director-schema';
import { DRAMA_SPEECH_LABELS, normalizeDramaSpeechSettings } from '@/lib/shared/drama-speech-settings';
import { DramaSpeechControls } from './DramaSpeechControls';
import { DramaChapterTitleControls } from './DramaChapterTitleControls';
import { normalizeDramaChapterTitleSettings, dramaChapterTitleSegment, needsSeparateDramaChapterTitle } from '@/lib/shared/drama-chapter-titles';

export function GeminiDramaSpeakerReview({ bookId, chapterIndex, profileId, chapterTitle, chapterText, hasEditedText, onDirtyChange }: {
  bookId: string; chapterIndex: number; profileId: string; chapterText: string; hasEditedText: boolean;
  chapterTitle?: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [savedReview, setSavedReview] = useState<DramaSpeakerReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [castNames, setCastNames] = useState<string[]>([]);
  const [castVoices, setCastVoices] = useState<Record<string, { voiceId: string; ttsModel?: string }>>({});
  const [speechTypes, setSpeechTypes] = useState(normalizeDramaSpeechSettings());
  const [chapterTitles, setChapterTitles] = useState(normalizeDramaChapterTitleSettings());
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedMessage, setSavedMessage] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const dirtyRef = useRef(false);
  const actionControllerRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const review = getMatchingDramaSpeakerReview(savedReview, chapterText);
  const separateTitle = review && needsSeparateDramaChapterTitle(review.segments, chapterTitle) ? dramaChapterTitleSegment(chapterTitle) : null;
  const titleVoice = chapterTitles.voiceId || castVoices.Narrator?.voiceId || '';
  const titleTurnOffset = separateTitle && chapterTitles.enabled ? 1 : 0;

  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSavedReview(null);
    setLoading(true);
    setError(null);
    dirtyRef.current = false; setDirty(false); setSavedMessage(false);
    const load = async () => {
      try {
        const response = await fetch(`/api/audiobook/drama-segments?bookId=${encodeURIComponent(bookId)}&chapterIndex=${chapterIndex}`, {
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Could not load speaker assignments.');
        const body = await response.json() as { review: DramaSpeakerReview | null; castNames?: string[]; speechTypes?: unknown; chapterTitles?: unknown; castVoices?: typeof castVoices };
        if (!cancelled && !dirtyRef.current) {
          setSavedReview((previous) => JSON.stringify(previous) === JSON.stringify(body.review) ? previous : body.review);
          setCastNames(body.castNames ?? []);
          setCastVoices(body.castVoices ?? {});
          setSpeechTypes(normalizeDramaSpeechSettings(body.speechTypes));
          setChapterTitles(normalizeDramaChapterTitleSettings(body.chapterTitles));
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not load speaker assignments.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); };
  }, [bookId, chapterIndex, reloadVersion]);

  useEffect(() => () => {
    actionControllerRef.current?.abort();
    audioRef.current?.pause();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);

  const markDirty = () => { dirtyRef.current = true; setDirty(true); setSavedMessage(false); };
  const changeTurn = (index: number, patch: Partial<Pick<DramaSpeakerReviewTurn, 'speaker' | 'utteranceType'>>) => {
    markDirty(); setSavedReview(current => current ? { ...current, segments: current.segments.map((turn, i) => i === index ? {
      ...turn, ...patch, ...(patch.speaker && castVoices[patch.speaker] ? castVoices[patch.speaker] : {}),
      ...((patch.utteranceType ?? turn.utteranceType) === 'chapter-title' && titleVoice ? { voiceId: titleVoice } : {}),
    } : turn) } : null);
  };
  const save = async () => {
    if (!review) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch('/api/audiobook/drama-segments', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, chapterIndex, revision: review.revision, speechTypes, chapterTitles,
          turns: review.segments.map((turn, index) => ({ index, speaker: turn.speaker, utteranceType: turn.utteranceType })) }) });
      const body = await response.json() as { review?: DramaSpeakerReview; error?: string };
      if (!response.ok || !body.review) throw new Error(body.error || 'Could not save speaker turns.');
      setSavedReview(body.review); dirtyRef.current = false; setDirty(false); setSavedMessage(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save speaker turns.'); }
    finally { setSaving(false); }
  };

  const prepare = async () => {
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setPreparing(true);
    setError(null);
    try {
      const response = await fetch('/api/audiobook/drama-segments', {
        signal: controller.signal,
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, chapterIndex, profileId, chapterTitle }),
      });
      const body = await response.json() as { review?: DramaSpeakerReview; error?: string };
      if (!response.ok || !body.review) throw new Error(body.error || 'Could not prepare speaker review.');
      setSavedReview(body.review);
      setSpeechTypes(normalizeDramaSpeechSettings(body.review.speechTypes));
      setChapterTitles(normalizeDramaChapterTitleSettings(body.review.chapterTitles));
      dirtyRef.current = false; setDirty(false); setSavedMessage(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not prepare speaker review.');
    } finally { setPreparing(false); }
  };

  const preview = async (segment: DramaSpeakerReviewTurn, index: number) => {
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    audioRef.current?.pause();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    setPreviewing(index);
    setError(null);
    try {
      const response = await fetch('/api/audiobook/characters/preview', {
        signal: controller.signal,
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: bookId, profileId: review?.profileId || profileId,
          characterName: segment.speaker, voiceName: segment.utteranceType === 'chapter-title' ? titleVoice || segment.voiceId : segment.voiceId, modelName: segment.ttsModel,
          text: segment.text.slice(0, 300), sceneContext: segment.sceneContext, previewMode: 'scene',
          utteranceType: segment.utteranceType, performance: segment.performance, speechTypes, chapterTitles }),
      });
      if (!response.ok) throw new Error('Could not preview this character. Check the saved cast and Gemini profile.');
      const url = URL.createObjectURL(await response.blob());
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      const finish = () => {
        setPreviewing(null);
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) audioRef.current = null;
        if (audioUrlRef.current === url) audioUrlRef.current = null;
      };
      audio.onended = finish;
      audio.onerror = finish;
      await audio.play();
    } catch (failure) {
      setPreviewing(null);
      setError(failure instanceof Error ? failure.message : 'Could not play preview.');
    }
  };

  return (
    <section className="space-y-3 text-sm" aria-label="Gemini Drama speaker turns">
      <p className="text-xs text-text-soft">Speaking turns within this chunk, in story order.</p>
      {error && <p role="alert" className="rounded border border-line-soft p-2 text-text-strong">{error}</p>}
      {loading ? <p>Loading speaker turns…</p> : !review ? (
        <div className="space-y-2 rounded border border-line-soft p-3">
          <p>{hasEditedText || savedReview ? 'The chapter text has changed; its saved speaker assignments no longer match.' : 'This chapter has no saved Gemini speaker assignments yet.'}</p>
          <p className="text-xs text-text-soft">Prepare speaker review to separate narration and character turns. This runs the Gemini Director without recording audio.</p>
          <button type="button" onClick={() => void prepare()} disabled={preparing || hasEditedText || !profileId}
            className="rounded bg-accent px-3 py-2 text-background disabled:opacity-50">
            {preparing ? 'Preparing speaker turns…' : 'Prepare speaker review'}
          </button>
          {hasEditedText && <p className="text-xs text-text-soft">Save and re-record your edits first to refresh speaker assignments.</p>}
        </div>
      ) : (
        <>
          {!review.complete && <p className="text-xs text-text-soft">Only the validated opening turns are available. The Director failed before completing this chunk.</p>}
          {review.preparedOnly && <p className="text-xs text-text-soft">These assignments were prepared from saved text. The existing audio has not been re-recorded.</p>}
          <button type="button" disabled={preparing || saving || dirty || hasEditedText || !profileId} onClick={() => void prepare()} className="rounded border border-line-soft px-3 py-2 disabled:opacity-50">
            {preparing ? 'Preparing speaker turns…' : 'Prepare speaker review again'}
          </button>
          {review.complete && <>
            <DramaChapterTitleControls profileId={review.profileId || profileId} disabled={saving || preparing || hasEditedText} value={chapterTitles}
              onChange={value => { markDirty(); setChapterTitles(value); }} />
            <DramaSpeechControls disabled={saving || preparing || hasEditedText} value={speechTypes} onChange={value => { markDirty(); setSpeechTypes(value); }} />
            <button type="button" disabled={!dirty || saving || preparing || hasEditedText} onClick={() => void save()} className="rounded bg-accent px-3 py-2 text-background disabled:opacity-50">
              {saving ? 'Saving speaker turns…' : 'Save speaker turns and sounds'}
            </button>
            {dirty && <button type="button" disabled={saving || preparing} onClick={() => setReloadVersion(version => version + 1)} className="rounded border border-line-soft px-3 py-2">
              Discard edits and reload saved turns
            </button>}
            {savedMessage && <p role="status">Saved. Re-record this chunk to apply your changes to its audio.</p>}
          </>}
          {separateTitle && <article aria-label="Chapter title announcement" className="space-y-2 rounded border border-line-soft p-3">
            <strong>{chapterTitles.enabled ? '1. ' : ''}Chapter title · {chapterTitles.enabled ? titleVoice || 'Narrator voice' : 'Skipped in recording'}</strong>
            <p>{separateTitle.text}</p>
            <button type="button" disabled={!chapterTitles.enabled || !titleVoice || previewing !== null} onClick={() => void preview({ ...separateTitle, voiceId: titleVoice }, -1)} className="rounded border border-line-soft px-2 py-1 text-xs disabled:opacity-50">
              {previewing === -1 ? 'Playing title sample…' : 'Preview chapter title'}
            </button>
          </article>}
          {review.segments.map((segment, index) => segment.text.trim() ? (
            <article key={index} className="space-y-2 rounded border border-line-soft bg-surface p-3" aria-label={`Turn ${index + 1 + titleTurnOffset}: ${segment.speaker}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{index + 1 + titleTurnOffset}. {segment.speaker}</strong>
                <span className="text-xs text-text-soft">{segment.utteranceType === 'chapter-title' ? titleVoice || segment.voiceId : segment.voiceId} · {DRAMA_SPEECH_LABELS[segment.utteranceType]}{segment.utteranceType === 'chapter-title' && !chapterTitles.enabled ? ' · Skipped in recording' : ''}</span>
              </div>
              <p className="whitespace-pre-wrap leading-relaxed">{segment.text}</p>
              {review.complete && <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs">Speaker
                  <select aria-label={`Turn ${index + 1 + titleTurnOffset} speaker`} disabled={saving || preparing || hasEditedText} value={segment.speaker} onChange={e => changeTurn(index, { speaker: e.target.value })} className="block w-full rounded border border-line-soft bg-surface p-2">
                    {[...new Set([segment.speaker, ...castNames])].map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
                <label className="text-xs">Speech type
                  <select aria-label={`Turn ${index + 1 + titleTurnOffset} speech type`} disabled={saving || preparing || hasEditedText} value={segment.utteranceType} onChange={e => changeTurn(index, { utteranceType: e.target.value as typeof segment.utteranceType })} className="block w-full rounded border border-line-soft bg-surface p-2">
                    {DRAMA_UTTERANCE_TYPES.map(type => <option key={type} value={type}>{DRAMA_SPEECH_LABELS[type]}</option>)}
                  </select>
                </label>
              </div>}
              <button type="button" onClick={() => void preview(segment, index)} disabled={previewing !== null}
                className="rounded border border-line-soft px-2 py-1 text-xs text-text-strong disabled:opacity-50">
                {previewing === index ? 'Playing sample…' : 'Preview character sample'}
              </button>
            </article>
          ) : null)}
        </>
      )}
    </section>
  );
}
