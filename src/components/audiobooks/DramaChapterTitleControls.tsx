'use client';

import { useEffect, useState } from 'react';
import type { DramaChapterTitleSettings } from '@/lib/shared/drama-chapter-titles';
import type { GeminiVoiceCatalogEntry } from '@/lib/shared/gemini-voice-catalog';

export function DramaChapterTitleControls({ value, onChange, profileId, disabled = false }: {
  value: DramaChapterTitleSettings; onChange: (value: DramaChapterTitleSettings) => void; profileId: string; disabled?: boolean;
}) {
  const [voices, setVoices] = useState<GeminiVoiceCatalogEntry[]>([]);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!value.enabled || !profileId) return;
    const controller = new AbortController();
    setNotice('Loading title voices…');
    void fetch(`/api/audiobook/voices/gemini?profileId=${encodeURIComponent(profileId)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load title voices. Save the Gemini profile and try again.');
        if (!controller.signal.aborted) { setVoices(body.voices ?? []); setNotice(''); }
      }).catch(error => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Could not load title voices.'); });
    return () => controller.abort();
  }, [profileId, value.enabled]);
  const uniqueVoices = [...new Map(voices.map(voice => [voice.id, voice])).values()];
  return <fieldset disabled={disabled} className="space-y-2 rounded border border-line-soft p-3">
    <legend className="text-sm font-semibold">Chapter titles</legend>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value.enabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
      Read chapter titles
    </label>
    <p className="text-xs text-text-soft">Read the saved title before the chapter and recognize headings in its text. An opening heading is read once. Turn this off to skip titles in recordings.</p>
    {value.enabled && <label className="block text-xs">Chapter title voice
      <select aria-label="Chapter title voice" value={value.voiceId} onChange={event => onChange({ ...value, voiceId: event.target.value })} className="mt-1 block w-full rounded border border-line-soft bg-surface p-2">
        <option value="">Use the narrator voice</option>
        {value.voiceId && !uniqueVoices.some(voice => voice.id === value.voiceId) && <option value={value.voiceId}>{value.voiceId}</option>}
        {uniqueVoices.map(voice => <option key={voice.id} value={voice.id}>{voice.displayName || voice.id}</option>)}
      </select>
    </label>}
    {value.enabled && notice && <p role="status" className="text-xs text-text-soft">{notice}</p>}
  </fieldset>;
}
