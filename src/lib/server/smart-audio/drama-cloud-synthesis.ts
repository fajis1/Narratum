import type { DramaDirectorSegment, DramaAudioTag } from '@/lib/shared/drama-director-schema';
import { DRAMA_ONE_SHOT_TAGS, DRAMA_PAUSE_TAGS, DRAMA_STYLE_TAGS } from '@/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { buildDramaCloudTtsRequest } from './drama-cloud-request';
import {
  CLOUD_TTS_SAFE_TEXT_BYTES, CloudTtsApiError, CloudTtsTransportError, measureUtf8Bytes,
  stripDisallowedTags, synthesizeWithCloudTts,
} from './google-cloud-tts-client';
import type { CloudTtsSynthesisOptions, CloudTtsSynthesisResult } from './google-cloud-tts-client';

const oneShot = new Set<string>(DRAMA_ONE_SHOT_TAGS);
const style = new Set<string>(DRAMA_STYLE_TAGS);
const pause = new Set<string>(DRAMA_PAUSE_TAGS);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface DramaSynthesisReviewFlag {
  kind: 'cloud-tts-failed';
  speaker: string;
  sourceText: string;
  chunkIndex: number;
  attempts: number;
  reason: string;
}

export interface DramaSynthesisChunk {
  sourceText: string;
  requestText: string;
  audioBuffer: Buffer | null;
  needsPlaceholder: boolean;
  omitted: boolean;
}

export interface DramaSynthesisResult {
  chunks: DramaSynthesisChunk[];
  reviewFlags: DramaSynthesisReviewFlag[];
}

/** Exact source partition, preferring whitespace and sentence boundaries. */
export function splitDramaTextByUtf8(text: string, maxBytes: number): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('Chunk byte budget must be at least four bytes.');
  if (!text) return [];
  const characters = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = start;
    let bytes = 0;
    while (end < characters.length) {
      const nextBytes = measureUtf8Bytes(characters[end]);
      if (bytes + nextBytes > maxBytes) break;
      bytes += nextBytes;
      end += 1;
    }
    if (end === start) throw new Error('A character exceeds the chunk byte budget.');
    if (end < characters.length) {
      let boundary = -1;
      for (let index = end - 1; index > start; index -= 1) {
        if (/\s/u.test(characters[index]) || /[.!?;:]/u.test(characters[index - 1])) {
          boundary = index + 1;
          break;
        }
      }
      if (boundary > start && boundary - start >= Math.floor((end - start) / 2)) end = boundary;
    }
    chunks.push(characters.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}

/** One-shot cues occur once; style affects each chunk; a pause ends the segment. */
export function annotateDramaChunks(chunks: readonly string[], tags: readonly DramaAudioTag[]): string[] {
  const starts = tags.filter((tag) => oneShot.has(tag)).map((tag) => `[${tag}]`).join(' ');
  const styles = tags.filter((tag) => style.has(tag)).map((tag) => `[${tag}]`).join(' ');
  const ends = tags.filter((tag) => pause.has(tag)).map((tag) => `[${tag}]`).join(' ');
  return chunks.map((chunk, index) => [
    index === 0 ? starts : '', styles, chunk,
    index === chunks.length - 1 ? ends : '',
  ].filter(Boolean).join(' '));
}

function tagReserveBytes(tags: readonly DramaAudioTag[]): number {
  return tags.reduce((sum, tag) => sum + measureUtf8Bytes(`[${tag}] `), 0) + 4;
}

function retryable(error: unknown): boolean {
  return error instanceof CloudTtsTransportError ||
    (error instanceof CloudTtsApiError && RETRYABLE_STATUSES.has(error.statusCode));
}

function failureReason(error: unknown): string {
  if (error instanceof CloudTtsApiError) return `Cloud TTS HTTP ${error.statusCode}`;
  return error instanceof Error ? error.name : 'Unknown synthesis error';
}

/** Synthesize all chunks, leaving failed chunks explicit for Stage 10 stitching. */
export async function synthesizeDramaSegment(input: {
  segment: DramaDirectorSegment;
  characterMap: SmartAudioCharacterMap;
  serviceAccountJson?: string;
  credentialCacheKey?: string;
  languageCode?: string;
  maxAttempts?: number;
  synthesize?: (options: CloudTtsSynthesisOptions) => Promise<CloudTtsSynthesisResult>;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<DramaSynthesisResult> {
  const { segment } = input;
  if (segment.omit_from_audio) {
    return { chunks: [{ sourceText: segment.text, requestText: '', audioBuffer: null, needsPlaceholder: false, omitted: true }], reviewFlags: [] };
  }
  const chunks: DramaSynthesisChunk[] = [];
  const reviewFlags: DramaSynthesisReviewFlag[] = [];
  const attemptsLimit = Math.min(Math.max(input.maxAttempts ?? 3, 1), 5);
  const synthesize = input.synthesize ?? synthesizeWithCloudTts;
  const wait = input.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  let sourceChunks: string[];
  let requestTexts: string[];
  let baseOptions: CloudTtsSynthesisOptions;
  try {
    if (stripDisallowedTags(segment.text).stripped.length) throw new Error('Source text contains unsafe bracketed content.');
    sourceChunks = splitDramaTextByUtf8(segment.text, CLOUD_TTS_SAFE_TEXT_BYTES - tagReserveBytes(segment.performance.tags));
    if (!sourceChunks.length) throw new Error('Source segment is empty.');
    const built = buildDramaCloudTtsRequest({
      segment: { ...segment, text: sourceChunks[0] },
      characterMap: input.characterMap,
      languageCode: input.languageCode,
    });
    baseOptions = built.synthesisOptions;
    requestTexts = annotateDramaChunks(sourceChunks, segment.performance.tags);
    for (const requestText of requestTexts) {
      if (measureUtf8Bytes(requestText) > CLOUD_TTS_SAFE_TEXT_BYTES) throw new Error('Annotated chunk exceeds the Cloud TTS byte limit.');
    }
  } catch (error) {
    return {
      chunks: [{ sourceText: segment.text, requestText: '', audioBuffer: null, needsPlaceholder: true, omitted: false }],
      reviewFlags: [{ kind: 'cloud-tts-failed', speaker: segment.speaker, sourceText: segment.text, chunkIndex: 0, attempts: 0, reason: failureReason(error) }],
    };
  }

  for (const [index, sourceText] of sourceChunks.entries()) {
    const requestText = requestTexts[index];
    let lastError: unknown;
    let usedAttempts = 0;
    for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
      usedAttempts = attempt;
      try {
        const result = await synthesize({
          ...baseOptions,
          text: requestText,
          serviceAccountJson: input.serviceAccountJson,
          credentialCacheKey: input.credentialCacheKey,
        });
        if (result.audioBuffer.length === 0) throw new Error('Empty Cloud TTS audio');
        chunks.push({ sourceText, requestText, audioBuffer: result.audioBuffer, needsPlaceholder: false, omitted: false });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempt === attemptsLimit) break;
        await wait(250 * 2 ** (attempt - 1));
      }
    }
    if (lastError) {
      chunks.push({ sourceText, requestText, audioBuffer: null, needsPlaceholder: true, omitted: false });
      reviewFlags.push({
        kind: 'cloud-tts-failed', speaker: segment.speaker, sourceText,
        chunkIndex: index, attempts: usedAttempts, reason: failureReason(lastError),
      });
    }
  }
  return { chunks, reviewFlags };
}
