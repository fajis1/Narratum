import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS,
  batchAudiobookText,
  batchAudiobookTextLegacy,
  cleanupBatchTargetForVersion,
  CURRENT_AUDIOBOOK_BATCH_VERSION,
  LEGACY_AUDIOBOOK_CLEANUP_TARGET_CHARACTERS,
  queuedAudiobookBatchVersion,
  splitAudiobookTextForTts,
  SMART_AUDIO_CLEANUP_TARGET_CHARACTERS,
  SMART_AUDIO_MAX_UNSPLIT_PARAGRAPH_CHARACTERS,
} from '../../src/lib/shared/audiobook-batching';

describe('audiobook cleanup batching', () => {
  test('preserves legacy chapter maps when existing audio has no version metadata', () => {
    expect(queuedAudiobookBatchVersion(true, undefined)).toBe(1);
    expect(queuedAudiobookBatchVersion(true, 1)).toBe(1);
    expect(queuedAudiobookBatchVersion(true, CURRENT_AUDIOBOOK_BATCH_VERSION))
      .toBe(CURRENT_AUDIOBOOK_BATCH_VERSION);
    expect(queuedAudiobookBatchVersion(false, undefined))
      .toBe(CURRENT_AUDIOBOOK_BATCH_VERSION);
  });

  test('uses a 12,000-character cleanup target', () => {
    expect(SMART_AUDIO_CLEANUP_TARGET_CHARACTERS).toBe(12_000);
    expect(SMART_AUDIO_MAX_UNSPLIT_PARAGRAPH_CHARACTERS).toBe(14_000);
    expect(AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS).toBe(4_000);
    expect(cleanupBatchTargetForVersion(CURRENT_AUDIOBOOK_BATCH_VERSION)).toBe(12_000);
    expect(cleanupBatchTargetForVersion(undefined)).toBe(4_000);
  });

  test('combines paragraphs until the target without breaking them', () => {
    const paragraph = (label: string) => `${label} ${'word '.repeat(790).trim()}.`;
    const batches = batchAudiobookText([{
      index: 0,
      title: 'Chapter One',
      text: [paragraph('one'), paragraph('two'), paragraph('three'), paragraph('four')].join('\n\n'),
    }]);

    expect(batches).toHaveLength(2);
    expect(batches[0].text).toContain('one');
    expect(batches[0].text).toContain('three');
    expect(batches[0].text).not.toContain('four');
    expect(batches.every((batch) => batch.text.length <= 12_000)).toBe(true);
  });

  test('splits an oversized paragraph at sentence boundaries', () => {
    const sentence = `A complete sentence ${'word '.repeat(95).trim()}.`;
    const batches = batchAudiobookText([{
      index: 0,
      title: 'Long Chapter',
      text: Array.from({ length: 30 }, () => sentence).join(' '),
    }]);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.text.length <= 12_000)).toBe(true);
    expect(batches.every((batch) => batch.text.endsWith('.'))).toBe(true);
  });

  test('keeps a PDF sentence continuation across blank lines in the same recording batch', () => {
    const text = 'A complete opening.\n\n"Tonight we have potatoes and\n\nasparagus from our greenhouse," Ali said.\n\nA new paragraph begins.';
    const batches = batchAudiobookText([{ index: 0, title: 'Opening', text }], 50);
    expect(batches.map(batch => batch.text).join('\n\n')).toBe(text);
    expect(batches.some(batch => batch.text.includes('potatoes and\n\nasparagus'))).toBe(true);
    expect(batches.some(batch => batch.text.endsWith('potatoes and'))).toBe(false);
  });

  test('preserves decimals and abbreviations in oversized paragraphs', () => {
    const paragraph = `${'A'.repeat(13_990)} The measurement was 3.14 units. Dr. Smith agreed.`;
    const batches = batchAudiobookText([{
      index: 0,
      title: 'Numeric Text',
      text: paragraph,
    }]);
    const recombined = batches.map((batch) => batch.text).join(' ');

    expect(recombined).toContain('3.14 units.');
    expect(recombined).toContain('Dr. Smith agreed.');
    expect(recombined).not.toContain('3. 14');
  });

  test('keeps a paragraph in the 12,000-to-14,000 grace range intact', () => {
    const paragraph = `Beginning ${'word '.repeat(2_550).trim()} ending.`;
    expect(paragraph.length).toBeGreaterThan(12_000);
    expect(paragraph.length).toBeLessThanOrEqual(14_000);

    const batches = batchAudiobookText([{
      index: 0,
      title: 'Grace Range',
      text: paragraph,
    }]);

    expect(batches).toEqual([{ index: 0, title: 'Grace Range', text: paragraph }]);
  });

  test('never repeats or drops text at batch boundaries', () => {
    const markers = Array.from({ length: 80 }, (_, index) => `UNIQUE_MARKER_${index}`);
    const text = markers
      .map((marker) => `${marker} ${'content '.repeat(35).trim()}.`)
      .join('\n\n');
    const batches = batchAudiobookText([{
      index: 0,
      title: 'Boundary Test',
      text,
    }]);
    const combined = batches.map((batch) => batch.text).join('\n\n');
    const emittedMarkers = combined.match(/UNIQUE_MARKER_\d+/gu) ?? [];

    for (const marker of markers) {
      expect(emittedMarkers.filter((emitted) => emitted === marker)).toHaveLength(1);
    }
    expect(emittedMarkers).toHaveLength(markers.length);
  });

  test('keeps a single oversized sentence intact', () => {
    const sentence = `Beginning ${'word '.repeat(2_500).trim()} ending.`;
    const batches = batchAudiobookText([{
      index: 0,
      title: 'Long Sentence',
      text: sentence,
    }]);

    expect(batches).toHaveLength(1);
    expect(batches[0].text).toBe(sentence);
    expect(batches[0].text.length).toBeGreaterThan(12_000);
  });

  test('splits a cleaned Gemini batch into separate TTS-safe requests', () => {
    const markers = Array.from({ length: 36 }, (_, index) => `TTS_MARKER_${index}`);
    const cleanedText = markers
      .map((marker) => `${marker} ${'spoken words '.repeat(28).trim()}.`)
      .join('\n\n');
    expect(cleanedText.length).toBeGreaterThan(AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS);

    const segments = splitAudiobookTextForTts(cleanedText);
    const emittedMarkers = segments
      .flatMap((segment) => segment.match(/TTS_MARKER_\d+/gu) ?? []);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => segment.length <= AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS)).toBe(true);
    for (const marker of markers) {
      expect(emittedMarkers.filter((emitted) => emitted === marker)).toHaveLength(1);
    }
  });

  test('hard-caps a malformed sentence with no nearby punctuation', () => {
    const text = `Start ${'unbroken prose '.repeat(500)}end`;
    const segments = splitAudiobookTextForTts(text);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => (
      segment.length <= AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS
    ))).toBe(true);
    expect(segments.join(' ').replace(/\s+/gu, ' ').trim())
      .toBe(text.replace(/\s+/gu, ' ').trim());
  });

  test('preserves the legacy 4K chapter map for resumable audiobooks', () => {
    const paragraphs = ['one', 'two', 'three'].map(
      (label) => `${label} ${'word '.repeat(510).trim()}`,
    );
    const raw = [{
      index: 0,
      title: 'Legacy',
      text: paragraphs.join('\n\n'),
    }];

    const legacy = batchAudiobookTextLegacy(raw);
    const current = batchAudiobookText(raw);

    expect(LEGACY_AUDIOBOOK_CLEANUP_TARGET_CHARACTERS).toBe(4_000);
    expect(legacy.map((batch) => batch.text)).toEqual(paragraphs);
    expect(current).toHaveLength(1);
  });

  test('uses the shared end-matter filter in both client generation paths', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/client/audiobooks/pipeline.ts'),
      'utf8',
    );
    expect(source.match(/truncateAudiobookEndMatter\(normalizedChapters\)/gu)).toHaveLength(2);
  });
});
