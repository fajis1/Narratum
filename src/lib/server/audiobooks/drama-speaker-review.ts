import { putAudiobookObject } from './blobstore';
import { resolveGeminiDramaVoiceEntry } from '@/lib/server/smart-audio/drama-cloud-request';
import { normalizeDramaChapterTitleSettings, type DramaChapterTitleSettings } from '@/lib/shared/drama-chapter-titles';
import { buildDramaDirectorPolicy } from '@/lib/shared/drama-profile-settings';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { DramaSpeakerReview } from '@/lib/shared/drama-speaker-review';
import type { SmartAudioCharacterMap } from '@/types/document-settings';
import { createHash, randomUUID } from 'node:crypto';
import { validateDramaDirectorOutput } from '@/lib/server/smart-audio/drama-director';
import { normalizeDramaSpeechSettings, type DramaSpeechSettings } from '@/lib/shared/drama-speech-settings';
import { getAudiobookObjectBuffer, isMissingBlobError } from './blobstore';
import { normalizeGeminiTtsCharacterMap } from '@/lib/server/smart-audio/gemini-cast-helpers';

export function dramaCastHash(map: SmartAudioCharacterMap): string {
  const normalized = normalizeGeminiTtsCharacterMap(map) ?? map;
  return createHash('sha256').update(JSON.stringify(Object.entries(normalized.entries).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}

export function dramaReviewRevision(review: DramaSpeakerReview): string {
  return review.revision ?? createHash('sha256').update(JSON.stringify(review)).digest('hex');
}

export function validateSavedDramaReview(review: DramaSpeakerReview, input: { sourceText: string; characterMap: SmartAudioCharacterMap; profileId: string }): DramaDirectorSegment[] {
  if (review.schemaVersion !== 1 || !review.complete || review.sourceText !== input.sourceText || review.profileId !== input.profileId || review.castHash !== dramaCastHash(input.characterMap)) {
    throw new Error('Speaker review no longer matches the saved text, profile, or cast. Prepare it again.');
  }
  return validateDramaDirectorOutput({ sourceText: input.sourceText, castNames: Object.keys(input.characterMap.entries),
    output: review.segments.map(({ voiceId: _voice, ttsModel: _model, ...segment }) => { void _voice; void _model; return segment; }) });
}

export async function loadReusableDramaReview(input: { bookId: string; userId: string; chapterIndex: number; profileId: string; sourceText: string; characterMap: SmartAudioCharacterMap; namespace?: string | null }): Promise<DramaSpeakerReview | null> {
  let review: DramaSpeakerReview;
  try { review = JSON.parse((await getAudiobookObjectBuffer(input.bookId, input.userId, dramaSpeakerReviewFileName(input.chapterIndex), input.namespace ?? null)).toString('utf8')); }
  catch (error) { if (isMissingBlobError(error)) return null; throw error; }
  // Old, incomplete or changed automatic direction can be prepared again. Explicit
  // user corrections must never disappear silently during re-recording.
  try { validateSavedDramaReview(review, input); return review; }
  catch (error) { if (review.reviewedAt) throw error; return null; }
}

export function dramaSpeakerReviewFileName(chapterIndex: number): string {
  return `${String(chapterIndex + 1).padStart(4, '0')}__drama_segments.json`;
}

export async function saveDramaSpeakerReview(input: {
  bookId: string; userId: string; chapterIndex: number; profileId: string;
  sourceText: string; characterMap: SmartAudioCharacterMap;
  segments: readonly DramaDirectorSegment[]; complete: boolean;
  preparedOnly?: boolean; namespace?: string | null;
  speechTypes?: DramaSpeechSettings; reviewedAt?: number;
  chapterTitles?: DramaChapterTitleSettings;
}): Promise<DramaSpeakerReview> {
  const review: DramaSpeakerReview = {
    schemaVersion: 1, chapterIndex: input.chapterIndex, profileId: input.profileId,
    sourceText: input.sourceText, complete: input.complete, preparedOnly: input.preparedOnly === true,
    revision: randomUUID(), castHash: dramaCastHash(input.characterMap),
    ...(input.speechTypes ? { speechTypes: normalizeDramaSpeechSettings(input.speechTypes) } : {}),
    ...(input.reviewedAt ? { reviewedAt: input.reviewedAt } : {}),
    ...(input.chapterTitles ? { chapterTitles: normalizeDramaChapterTitleSettings(input.chapterTitles) } : {}),
    segments: input.segments.map((segment) => {
      const entry = resolveGeminiDramaVoiceEntry(input.characterMap, segment, buildDramaDirectorPolicy({ chapterTitles: input.chapterTitles }));
      const ttsModel = 'ttsModel' in entry && typeof entry.ttsModel === 'string' ? entry.ttsModel : undefined;
      return { ...segment, voiceId: entry.voiceId!, ...(ttsModel ? { ttsModel } : {}) };
    }),
  };
  await putAudiobookObject(input.bookId, input.userId, dramaSpeakerReviewFileName(input.chapterIndex),
    Buffer.from(JSON.stringify(review)), 'application/json; charset=utf-8', input.namespace ?? null);
  return review;
}
