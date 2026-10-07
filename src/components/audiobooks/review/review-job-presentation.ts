// Generation and batch-regenerate jobs historically omit jobType.
export function reviewJobPresentation(jobType: unknown) {
  switch (jobType) {
    case 'batch-refine': return { label: 'AI Batch Refine', reviewChanges: true };
    case 'pronunciation-repair': return { label: 'Pronunciation Repair', reviewChanges: false };
    case undefined: case null: return { label: 'Generating audiobook', reviewChanges: false };
    case 'combine': return { label: 'Combining audiobook', reviewChanges: false };
    default: return { label: 'Background Job', reviewChanges: false };
  }
}
export function isActiveReviewJob(status?: string) {
  return ['queued', 'running', 'waiting_for_pdf', 'pausing'].includes(status || '');
}
