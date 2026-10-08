export type PronunciationRepairStatus = {
  changeId: string; runId: string; fileName: string; chapterIndex: number; title: string;
  decision: string; audioStatus: string; unresolvedCount: number; ready: boolean;
  /** Only an audited, approved Override supplies this exact UTF-8 text hash. */
  approvedOverrideTextHash?: string;
};

export function pronunciationRepairStatusLabel(repair: PronunciationRepairStatus): string {
  if (repair.decision === 'rejected') return 'Kept previous text';
  if (repair.decision === 'pending') return repair.ready ? 'Awaiting approval' : 'Needs review';
  if (repair.audioStatus === 'completed') return 'Complete';
  if (repair.audioStatus === 'error') return 'Recording failed — review to retry';
  if (repair.audioStatus === 'running') return 'Recording in progress';
  if (repair.audioStatus === 'queued') return 'Recording queued';
  return 'Approved — recording not requested';
}
