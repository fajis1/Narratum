import { putAudiobookObject } from './blobstore';
import { resolveGeminiCastEntry } from '@/lib/server/smart-audio/drama-cloud-request';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { DramaSpeakerReview } from '@/lib/shared/drama-speaker-review';
import type { SmartAudioCharacterMap } from '@/types/document-settings';

export function dramaSpeakerReviewFileName(chapterIndex: number): string {
  return `${String(chapterIndex + 1).padStart(4, '0')}__drama_segments.json`;
}

export async function saveDramaSpeakerReview(input: {
  bookId: string; userId: string; chapterIndex: number; profileId: string;
  sourceText: string; characterMap: SmartAudioCharacterMap;
  segments: readonly DramaDirectorSegment[]; complete: boolean;
  preparedOnly?: boolean; namespace?: string | null;
}): Promise<DramaSpeakerReview> {
  const review: DramaSpeakerReview = {
    schemaVersion: 1, chapterIndex: input.chapterIndex, profileId: input.profileId,
    sourceText: input.sourceText, complete: input.complete, preparedOnly: input.preparedOnly === true,
    segments: input.segments.map((segment) => {
      const entry = resolveGeminiCastEntry(input.characterMap, segment.speaker);
      const ttsModel = 'ttsModel' in entry && typeof entry.ttsModel === 'string' ? entry.ttsModel : undefined;
      return { ...segment, voiceId: entry.voiceId!, ...(ttsModel ? { ttsModel } : {}) };
    }),
  };
  await putAudiobookObject(input.bookId, input.userId, dramaSpeakerReviewFileName(input.chapterIndex),
    Buffer.from(JSON.stringify(review)), 'application/json; charset=utf-8', input.namespace ?? null);
  return review;
}
