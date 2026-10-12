import { describe, expect, it } from 'vitest';
import { classifyDramaChapterTitles, dramaChapterTitleSegment, needsSeparateDramaChapterTitle, normalizeDramaChapterTitleSettings } from '@/lib/shared/drama-chapter-titles';
import { buildDramaDirectorPolicy, normalizeDramaGeminiTtsProfileSettings } from '@/lib/shared/drama-profile-settings';
import { buildGeminiDramaTtsRequest } from '@/lib/server/smart-audio/drama-cloud-request';
import { buildDramaDirectorPrompt, validateDramaDirectorOutput } from '@/lib/server/smart-audio/drama-director';
import type { SmartAudioCharacterMap } from '@/types/document-settings';

const map: SmartAudioCharacterMap = { schemaVersion: 1, status: 'complete', scannedAt: 1,
  entries: { Narrator: { name: 'Narrator', voiceId: 'Kore', description: 'Calm storyteller.', sampleText: '' } } };
const narration = (text: string) => ({ ...dramaChapterTitleSegment('Heading')!, utteranceType: 'narration' as const, text });

describe('Gemini Drama chapter titles', () => {
  it('keeps title recording opt-in and normalizes a separate voice without losing speech settings', () => {
    expect(normalizeDramaGeminiTtsProfileSettings({}).chapterTitles).toEqual({ enabled: false, voiceId: '' });
    const settings = normalizeDramaGeminiTtsProfileSettings({ chapterTitles: { enabled: true, voiceId: ' Puck ' }, speechTypes: { 'chapter-title': { delivery: 'soft' } } });
    expect(settings.chapterTitles).toEqual({ enabled: true, voiceId: 'Puck' });
    expect(settings.speechTypes['chapter-title'].delivery).toBe('soft');
    expect(normalizeDramaChapterTitleSettings({ enabled: 'true', voiceId: 'bad/voice' })).toEqual({ enabled: false, voiceId: '' });
  });

  it('recognizes opening and embedded standalone headings, preserving every transcript byte', () => {
    const source = '\r\nChapter 1\r\n\r\nThe door opened.\n\nChapter II: Arrival\n\nShe stepped inside.';
    const turns = classifyDramaChapterTitles([narration(source)]);
    expect(turns.map(turn => turn.text).join('')).toBe(source);
    expect(turns.filter(turn => turn.utteranceType === 'chapter-title').map(turn => turn.text.trim())).toEqual(['Chapter 1', 'Chapter II: Arrival']);
    expect(needsSeparateDramaChapterTitle(turns, 'Arrival')).toBe(false);
    expect(validateDramaDirectorOutput({ sourceText: source, castNames: ['Narrator'], output: turns })).toEqual(turns);
  });

  it('recognizes an exact saved title but leaves narrative mentions and dialogue unchanged', () => {
    const turns = classifyDramaChapterTitles([narration('Arrival\n\nWe discussed Chapter 2 before dinner.\n'), { ...narration('Chapter 3'), utteranceType: 'spoken-dialogue' }], 'Arrival');
    expect(turns.filter(turn => turn.utteranceType === 'chapter-title')).toHaveLength(1);
    expect(turns.at(-1)?.utteranceType).toBe('spoken-dialogue');
    expect(needsSeparateDramaChapterTitle([narration('The door opened.')], 'Arrival')).toBe(true);
    expect(dramaChapterTitleSegment('   ')).toBeNull();
  });

  it('uses the selected title voice and title direction without changing the narrator cast', () => {
    const policy = buildDramaDirectorPolicy({ chapterTitles: { enabled: true, voiceId: 'Puck' } });
    const title = buildGeminiDramaTtsRequest({ characterMap: map, segment: dramaChapterTitleSegment('Chapter 1: Arrival')!, policy });
    expect(title.voiceName).toBe('Puck'); expect(title.requestText).toBe('Chapter 1: Arrival');
    expect(title.style).toContain('Announce this chapter title'); expect(title.style).not.toContain('Calm storyteller');
    expect(buildGeminiDramaTtsRequest({ characterMap: map, segment: narration('The door opened.'), policy }).voiceName).toBe('Kore');
    expect(map.entries.Narrator.voiceId).toBe('Kore');
    expect(buildGeminiDramaTtsRequest({ characterMap: map, segment: dramaChapterTitleSegment('Arrival')! }).voiceName).toBe('Kore');
    expect(buildGeminiDramaTtsRequest({ characterMap: { ...map, entries: { ...map.entries, Bethany: { ...map.entries.Narrator, name: 'Bethany', voiceId: 'Puck' } } },
      segment: { ...dramaChapterTitleSegment('Arrival')!, speaker: 'Bethany' } }).voiceName).toBe('Kore');
  });

  it('instructs the Director to retain and classify headings even when title recording is off', () => {
    const prompt = buildDramaDirectorPrompt({ sourceText: 'Chapter 1\nHello.', castNames: ['Narrator'] });
    expect(prompt).toContain('chapter-title'); expect(prompt).toContain('Keep their source spans');
  });
});
