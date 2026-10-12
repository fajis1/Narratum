import type { DramaDirectorSegment } from './drama-director-schema';
import { isSafeGeminiVoiceId } from './gemini-voice-catalog';

export interface DramaChapterTitleSettings { enabled: boolean; voiceId: string }

export function normalizeDramaChapterTitleSettings(value?: unknown): DramaChapterTitleSettings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { enabled: raw.enabled === true,
    voiceId: typeof raw.voiceId === 'string' && isSafeGeminiVoiceId(raw.voiceId.trim()) ? raw.voiceId.trim() : '' };
}

/** A saved chapter label is separate from the immutable body transcript. */
export function dramaChapterTitleSegment(title?: string): DramaDirectorSegment | null {
  const text = title?.trim();
  if (!text) return null;
  return { speaker: 'Narrator', utteranceType: 'chapter-title', text, sceneContext: 'Announce the chapter title clearly.', omit_from_audio: false,
    performance: { primaryEmotion: 'neutral', secondaryEmotions: [], socialIntent: 'informing', delivery: ['natural'], pace: 'normal', energy: 'normal', intensity: 'low', tags: [] } };
}

/** Recognize standalone headings in old automatic direction without losing any bytes. */
export function classifyDramaChapterTitles(segments: readonly DramaDirectorSegment[], title?: string): DramaDirectorSegment[] {
  return segments.flatMap(segment => {
    if (segment.utteranceType !== 'narration') return [segment];
    const pieces = segment.text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter(Boolean) ?? [];
    const result: DramaDirectorSegment[] = [];
    for (const text of pieces) {
      const label = text.trim().replace(/^#{1,6}\s+/u, '');
      const heading = label.length > 0 && label.length <= 500 && (label === title?.trim()
        || /^chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*[:.\-–—]\s*[^\n]+)?\s*$/iu.test(label));
      const type = heading ? 'chapter-title' : 'narration';
      const previous = result.at(-1);
      if (previous && previous.utteranceType === type && type === 'narration') previous.text += text;
      else result.push({ ...segment, text, utteranceType: type, ...(heading ? { speaker: 'Narrator' } : {}) });
    }
    return result;
  });
}

export function needsSeparateDramaChapterTitle(segments: readonly DramaDirectorSegment[], title?: string): boolean {
  return Boolean(title?.trim()) && segments.find(segment => segment.text.trim())?.utteranceType !== 'chapter-title';
}
