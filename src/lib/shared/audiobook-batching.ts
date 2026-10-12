import { splitTextToTtsBlocks } from '@/lib/shared/nlp';
import { segmentSentences } from '@/lib/shared/language';

export const SMART_AUDIO_CLEANUP_TARGET_CHARACTERS = 12_000;
export const SMART_AUDIO_MAX_UNSPLIT_PARAGRAPH_CHARACTERS = 14_000;
export const AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS = 4_000;
export const LEGACY_AUDIOBOOK_CLEANUP_TARGET_CHARACTERS = 4_000;
export const CURRENT_AUDIOBOOK_BATCH_VERSION = 2;

export function queuedAudiobookBatchVersion(
  hasExistingChapters: boolean,
  previousVersion: unknown,
): number {
  if (!hasExistingChapters) return CURRENT_AUDIOBOOK_BATCH_VERSION;
  return previousVersion === CURRENT_AUDIOBOOK_BATCH_VERSION
    ? CURRENT_AUDIOBOOK_BATCH_VERSION
    : 1;
}

export function cleanupBatchTargetForVersion(version: unknown): number {
  return version === CURRENT_AUDIOBOOK_BATCH_VERSION
    ? SMART_AUDIO_CLEANUP_TARGET_CHARACTERS
    : LEGACY_AUDIOBOOK_CLEANUP_TARGET_CHARACTERS;
}

export type AudiobookTextBatch = {
  index: number;
  title: string;
  text: string;
};

export function batchAudiobookTextLegacy(
  rawChapters: readonly AudiobookTextBatch[],
): AudiobookTextBatch[] {
  const batches: AudiobookTextBatch[] = [];
  let currentText = '';
  let currentTitle = rawChapters[0]?.title || '';

  const flush = () => {
    if (!currentText) return;
    batches.push({
      index: batches.length,
      title: currentTitle,
      text: currentText,
    });
    currentText = '';
  };

  for (const chapter of rawChapters) {
    const paragraphs = chapter.text
      .split('\n\n')
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    for (const paragraph of paragraphs) {
      const addedLength = currentText ? paragraph.length + 2 : paragraph.length;
      if (
        currentText
        && currentText.length + addedLength > LEGACY_AUDIOBOOK_CLEANUP_TARGET_CHARACTERS
      ) {
        flush();
        currentTitle = chapter.title;
      }
      if (!currentText) currentTitle = chapter.title;
      currentText += `${currentText ? '\n\n' : ''}${paragraph}`;
    }
  }
  flush();
  return batches;
}

export function splitAudiobookTextForTts(
  text: string,
  language?: string,
): string[] {
  const sentenceAwareBlocks = splitTextToTtsBlocks(text, {
    language,
    maxBlockLength: AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS,
  }).filter(Boolean);
  return sentenceAwareBlocks.flatMap((block) => {
    const segments: string[] = [];
    let remaining = block;
    while (remaining.length > AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS) {
      const candidate = remaining.slice(0, AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS + 1);
      const whitespaceCut = candidate.search(/\s+\S*$/u);
      const cut = whitespaceCut > 0
        ? whitespaceCut
        : AUDIOBOOK_TTS_SEGMENT_MAX_CHARACTERS;
      segments.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) segments.push(remaining);
    return segments;
  });
}

function splitLongParagraph(paragraph: string, targetCharacters: number): string[] {
  if (paragraph.length <= SMART_AUDIO_MAX_UNSPLIT_PARAGRAPH_CHARACTERS) return [paragraph];

  // Intl.Segmenter preserves decimal and abbreviation periods that a
  // punctuation-only regex would mistake for sentence boundaries.
  const sentences = segmentSentences(paragraph);
  const pieces: string[] = [];
  let current = '';

  const flush = () => {
    if (current) pieces.push(current);
    current = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > targetCharacters) {
      flush();
      // Sentence integrity is more important than the soft target. A malformed
      // or unusually long sentence may therefore produce one oversized batch.
      pieces.push(sentence);
      continue;
    }

    const separatorLength = current ? 1 : 0;
    if (current && current.length + separatorLength + sentence.length > targetCharacters) {
      flush();
    }
    current += `${current ? ' ' : ''}${sentence}`;
  }
  flush();
  return pieces;
}

export function batchAudiobookText(
  rawChapters: readonly AudiobookTextBatch[],
  targetCharacters = SMART_AUDIO_CLEANUP_TARGET_CHARACTERS,
): AudiobookTextBatch[] {
  if (!Number.isFinite(targetCharacters) || targetCharacters < 1) {
    throw new Error('Audiobook batch target must be a positive number.');
  }

  const batches: AudiobookTextBatch[] = [];
  let currentText = '';
  let currentTitle = rawChapters[0]?.title || '';

  const flush = () => {
    const text = currentText.trim();
    if (text) {
      batches.push({ index: batches.length, title: currentTitle, text });
    }
    currentText = '';
  };

  for (const chapter of rawChapters) {
    const paragraphs = chapter.text
      .split(/\n\s*\n/u)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .flatMap((paragraph) => splitLongParagraph(paragraph, targetCharacters));

    for (const paragraph of paragraphs) {
      const addedLength = paragraph.length + (currentText ? 2 : 0);
      // PDF extraction may insert a blank line inside a sentence. The target
      // is soft: keep its lowercase continuation with the preceding fragment.
      const continuesSentence = currentText && !/[.!?…'"”’\]}):;]\s*$/u.test(currentText)
        && /^[\p{Ll}\p{M}]/u.test(paragraph);
      if (currentText && !continuesSentence && currentText.length + addedLength > targetCharacters) {
        flush();
      }
      if (!currentText) currentTitle = chapter.title;
      currentText += `${currentText ? '\n\n' : ''}${paragraph}`;
    }
  }
  flush();
  return batches;
}
