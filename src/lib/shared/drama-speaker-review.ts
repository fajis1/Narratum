import type { DramaDirectorSegment } from './drama-director-schema';
import type { DramaSpeechSettings } from './drama-speech-settings';
import type { DramaChapterTitleSettings } from './drama-chapter-titles';

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
  revision?: string;
  castHash?: string;
  reviewedAt?: number;
  speechTypes?: DramaSpeechSettings;
  chapterTitles?: DramaChapterTitleSettings;
}

/** Edited text must never display assignments from a different transcript. */
export function getMatchingDramaSpeakerReview(value: DramaSpeakerReview | null, text: string): DramaSpeakerReview | null {
  return value?.schemaVersion === 1 && value.sourceText === text ? value : null;
}
