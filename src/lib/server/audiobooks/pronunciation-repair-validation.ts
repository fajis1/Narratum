import { pronunciationMarkupRegions } from '@/lib/shared/pronunciation-repair-markup';
import { assertPronunciationRepair, scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';
import { validateSmartAudioOutput } from '@/lib/shared/smart-audio-cleanup';
import { getAudiobookObjectBuffer } from './blobstore';

export const PRONUNCIATION_REVIEW_OVERRIDE_NOTE = '[Reviewer override: pronunciation warnings; source integrity retained.]';
export function hasPronunciationReviewOverride(note?: string | null): boolean {
  return note?.includes(PRONUNCIATION_REVIEW_OVERRIDE_NOTE) === true;
}

/** Recheck source evidence at approval and recording, never trust an AI claim. */
export async function assertStoredPronunciationRepair(input: {
  bookId: string; userId: string; fileName: string; previous: string; proposed: string; allowSourceEvidenceOverride?: boolean; overrideIssueIds?: string[]; allowFullManualOverride?: boolean; overridePronunciationReview?: boolean;
}) {
  if (input.overridePronunciationReview) {
    // Only pronunciation/completeness findings are overridable here. Keep the
    // exact source/flagged-region boundary and never combine with source overrides.
    assertPronunciationRepair(input.previous, input.proposed, { allowRemaining: true });
    const regions = pronunciationMarkupRegions(input.proposed);
    const starts = new Set(regions.filter(region => !region.nested && /^\[[^\[\]\r\n]+\]\(\/[^/\r\n]+\/\)$/u.test(input.proposed.slice(region.start, region.end))).map(region => region.start));
    if ([...input.proposed.matchAll(/\[[^\[\]\r\n]+\]\(\//gu)].some(tag => !starts.has(tag.index))) {
      throw new Error('Override cannot accept malformed pronunciation markup. Correct the markup before recording.');
    }
    if (scanPronunciationIssues(input.proposed).some(issue => issue.kind === 'formatting' || issue.kind === 'structural')) {
      throw new Error('Override cannot accept malformed pronunciation markup. Correct the markup before recording.');
    }
    return;
  }
  if (input.allowFullManualOverride) {
    const previousVoices = input.previous.match(/<\/?voice\b[^>]*>/gu) || [];
    const proposedVoices = input.proposed.match(/<\/?voice\b[^>]*>/gu) || [];
    if (JSON.stringify(previousVoices) !== JSON.stringify(proposedVoices)) {
      throw new Error('A pronunciation-repair override cannot change speaker assignments.');
    }
    validateSmartAudioOutput(input.proposed, { requirePronunciationTagsForForeignScripts: true });
    return;
  }
  if (input.allowSourceEvidenceOverride || input.overrideIssueIds?.length) {
    const ids = new Set(input.overrideIssueIds || []);
    const allow = input.overrideIssueIds?.length
      ? (issue: { id: string }) => ids.has(issue.id)
      : true;
    assertPronunciationRepair(input.previous, input.proposed, { allowSourceEvidenceOverride: allow });
    return;
  }
  try { assertPronunciationRepair(input.previous, input.proposed); return; }
  catch (error) {
    if (!(error instanceof Error) || !error.message.includes('English')) throw error;
  }
  const prefix = input.fileName.split('__')[0];
  let sourceText: string;
  if (input.fileName.endsWith('__rejected.txt')) {
    const metadata = JSON.parse((await getAudiobookObjectBuffer(input.bookId, input.userId, `${prefix}__pronunciation_failure.json`, null)).toString('utf8'));
    sourceText = typeof metadata.sourceText === 'string' ? metadata.sourceText : '';
  } else {
    sourceText = (await getAudiobookObjectBuffer(input.bookId, input.userId, `${prefix}__original.txt`, null)).toString('utf8');
  }
  assertPronunciationRepair(input.previous, input.proposed, { sourceText });
}
