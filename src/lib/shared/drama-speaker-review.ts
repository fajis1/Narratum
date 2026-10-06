import type { DramaDirectorSegment } from './drama-director-schema';

export interface DramaSpeakerReviewTurn extends DramaDirectorSegment {
  voiceId: string;
  ttsModel?: string;
}

export interface DramaSpeakerReview {
  schemaVersion: 1;
  chapterIndex: number;
  profileId: string;
  sourceText: string;
  complete: boolean;
  preparedOnly: boolean;
  segments: DramaSpeakerReviewTurn[];
}

/** Edited text must never display assignments from a different transcript. */
export function getMatchingDramaSpeakerReview(value: DramaSpeakerReview | null, text: string): DramaSpeakerReview | null {
  return value?.schemaVersion === 1 && value.sourceText === text ? value : null;
}
