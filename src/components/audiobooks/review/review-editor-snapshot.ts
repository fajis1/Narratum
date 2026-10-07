// Shared by Save & Re-record and AI Clean: never clear a newer editor or speaker draft.
export function submittedChapterIsCurrent(current: { index?: number; text: string }, submitted: { index: number; text: string; drafts: string }, drafts: string, textOverride?: string) {
  return current.index === submitted.index && (current.text === submitted.text || (textOverride !== undefined && current.text === textOverride)) && drafts === submitted.drafts;
}
