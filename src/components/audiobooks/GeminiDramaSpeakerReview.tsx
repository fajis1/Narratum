'use client';

import { useEffect, useRef, useState } from 'react';
import { getMatchingDramaSpeakerReview } from '@/lib/shared/drama-speaker-review';
import type { DramaSpeakerReview, DramaSpeakerReviewTurn } from '@/lib/shared/drama-speaker-review';

export function GeminiDramaSpeakerReview({ bookId, chapterIndex, profileId, chapterText, hasEditedText }: {
  bookId: string; chapterIndex: number; profileId: string; chapterText: string; hasEditedText: boolean;
}) {
  const [savedReview, setSavedReview] = useState<DramaSpeakerReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const review = getMatchingDramaSpeakerReview(savedReview, chapterText);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSavedReview(null);
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/audiobook/drama-segments?bookId=${encodeURIComponent(bookId)}&chapterIndex=${chapterIndex}`, {
          cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Could not load speaker assignments.');
        const body = await response.json() as { review: DramaSpeakerReview | null };
        if (!cancelled) setSavedReview((previous) => JSON.stringify(previous) === JSON.stringify(body.review) ? previous : body.review);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'Could not load speaker assignments.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => { cancelled = true; controller.abort(); clearInterval(interval); };
  }, [bookId, chapterIndex]);

  useEffect(() => () => {
    actionControllerRef.current?.abort();
    audioRef.current?.pause();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
  }, []);

  const prepare = async () => {
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setPreparing(true);
    setError(null);
    try {
      const response = await fetch('/api/audiobook/drama-segments', {
        signal: controller.signal,
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, chapterIndex, profileId }),
      });
      const body = await response.json() as { review?: DramaSpeakerReview; error?: string };
      if (!response.ok || !body.review) throw new Error(body.error || 'Could not prepare speaker review.');
      setSavedReview(body.review);
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
          characterName: segment.speaker, voiceName: segment.voiceId, modelName: segment.ttsModel,
          text: segment.text.slice(0, 300), sceneContext: segment.sceneContext, previewMode: 'scene' }),
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
          {review.segments.map((segment, index) => segment.text.trim() ? (
            <article key={index} className="space-y-2 rounded border border-line-soft bg-surface p-3" aria-label={`Turn ${index + 1}: ${segment.speaker}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{index + 1}. {segment.speaker}</strong>
                <span className="text-xs text-text-soft">{segment.voiceId} · {segment.utteranceType.replaceAll('-', ' ')}</span>
              </div>
              <p className="whitespace-pre-wrap leading-relaxed">{segment.text}</p>
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
