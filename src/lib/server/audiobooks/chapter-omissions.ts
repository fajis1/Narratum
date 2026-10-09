import { batchRefineTextHash } from './batch-refine-assessment';
import { extractNarratableSmartAudioSourceText, hasConfirmedSmartAudioEndMatterHint, stripSmartAudioInputMarkers } from '@/lib/shared/smart-audio-cleanup';

export const CHAPTER_OMISSION_VALIDATION_VERSION = 1;

export type ChapterOmissionReason = 'empty_source' | 'confirmed_end_matter' | 'confirmed_structural_material';
export type ChapterOmissionEvidence = {
  chapterIndex: number;
  reason: ChapterOmissionReason;
  sourceHash: string;
  validatedAt: number;
  validationVersion: number;
};
export type OmissionSourceChapter = { index: number; title?: string; text: string; cleanupText?: string };

export function chapterOmissionSource(chapter: OmissionSourceChapter): string {
  return chapter.cleanupText ?? chapter.text;
}

export function chapterOmissionSourceHash(chapter: OmissionSourceChapter): string {
  return batchRefineTextHash(`${chapter.index}\0${chapter.title ?? ''}\0${chapterOmissionSource(chapter)}`);
}

export function getChapterOmissionReason(chapter: OmissionSourceChapter): ChapterOmissionReason | null {
  const source = chapterOmissionSource(chapter);
  if (!stripSmartAudioInputMarkers(source).trim()) return 'empty_source';
  // Non-narrative omissions require server-authored layout tags, and end
  // matter additionally requires its server-authored late-book location hint.
  if (/\[LAYOUT_ENGINE_TAG\s*:/iu.test(source) && !extractNarratableSmartAudioSourceText(source).trim()) {
    return hasConfirmedSmartAudioEndMatterHint(source) ? 'confirmed_end_matter' : 'confirmed_structural_material';
  }
  return null;
}

export function createChapterOmissionEvidence(
  chapter: OmissionSourceChapter,
  reason: ChapterOmissionReason,
  validatedAt = Date.now(),
): ChapterOmissionEvidence | null {
  if (getChapterOmissionReason(chapter) !== reason) return null;
  return {
    chapterIndex: chapter.index,
    reason,
    sourceHash: chapterOmissionSourceHash(chapter),
    validatedAt,
    validationVersion: CHAPTER_OMISSION_VALIDATION_VERSION,
  };
}

export function isValidChapterOmissionEvidence(
  value: unknown,
  chapter: OmissionSourceChapter,
): value is ChapterOmissionEvidence {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Partial<ChapterOmissionEvidence>;
  return evidence.chapterIndex === chapter.index
    && (evidence.reason === 'empty_source' || evidence.reason === 'confirmed_end_matter' || evidence.reason === 'confirmed_structural_material')
    && evidence.validationVersion === CHAPTER_OMISSION_VALIDATION_VERSION
    && typeof evidence.validatedAt === 'number' && Number.isFinite(evidence.validatedAt) && evidence.validatedAt > 0
    && evidence.sourceHash === chapterOmissionSourceHash(chapter)
    && getChapterOmissionReason(chapter) === evidence.reason;
}

