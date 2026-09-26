import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { audiobookJobs, batchRefineChanges, batchRefineRuns } from '@/db/schema';
import { canonicalRepairTextFile, PRONUNCIATION_REPAIR_RULE } from '@/lib/shared/pronunciation-issues';
import { assertStoredPronunciationRepair } from './pronunciation-repair-validation';
import { parseVoiceTaggedText } from '@/lib/shared/multi-voice';
import {
  batchRefineFlagDefinitions,
  BATCH_REFINE_PROFILE_REVIEW_CONFIG,
  BATCH_REFINE_RECORDING_OPTION_HELP,
  type BatchRefineProfileCategory,
  type BatchRefineRecordingMode,
} from '@/lib/shared/batch-refine-review';
import {
  batchRefineTextHash,
  calculateBatchRefineMetrics,
  type BatchRefineMetrics,
} from '@/lib/server/audiobooks/batch-refine-assessment';
import { hasUntaggedScholarForeignScript } from '@/lib/server/audiobooks/batch-refine-scholar-safety';
import {
  getAudiobookObjectBuffer,
  listAudiobookObjects,
  putAudiobookObject,
} from '@/lib/server/audiobooks/blobstore';

export class BatchRefineReviewConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchRefineReviewConflictError';
  }
}

const RECORDING_VOICE_MARKER = /\[Recording voice=([^\]]+)\]/u;

function validatedRecordingVoice(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const voice = value.trim();
  if (!voice || voice.length > 100 || /[\u0000-\u001f\u007f\[\]]/u.test(voice)) {
    throw new BatchRefineReviewConflictError('Choose a valid recording voice.');
  }
  return voice;
}

function reviewNoteWithRecordingVoice(note: string | null, voice: string | undefined): string | null {
  if (!voice) return note;
  const marker = `[Recording voice=${voice}]`;
  return RECORDING_VOICE_MARKER.test(note || '')
    ? (note || '').replace(RECORDING_VOICE_MARKER, marker)
    : `${note || ''}${note ? ' ' : ''}${marker}`;
}

export function recordingVoiceFromReviewNote(note: string | null | undefined): string | undefined {
  return note?.match(RECORDING_VOICE_MARKER)?.[1];
}

export async function createBatchRefineRun(input: {
  id: string;
  jobId: string;
  userId: string;
  documentId: string;
  profileId: string | null;
  profileCategory: BatchRefineProfileCategory;
  rule: string;
  recordingMode: BatchRefineRecordingMode;
  holdHighPriority: boolean;
}): Promise<void> {
  const now = Date.now();
  await db.insert(batchRefineRuns).values({
    ...input,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  });
}

export async function markBatchRefineRunStarted(runId: string, totalChapters: number): Promise<void> {
  await db.update(batchRefineRuns).set({
    status: 'running',
    totalChapters,
    updatedAt: Date.now(),
  }).where(eq(batchRefineRuns.id, runId));
}

export async function getBatchRefineRunState(runId: string, userId: string) {
  const rows = await db.select().from(batchRefineRuns).where(and(
    eq(batchRefineRuns.id, runId),
    eq(batchRefineRuns.userId, userId),
  )).limit(1);
  return rows[0] || null;
}

export async function getBatchRefineProposalForChapter(input: {
  runId: string;
  userId: string;
  chapterIndex: number;
}) {
  const rows = await db.select({ id: batchRefineChanges.id }).from(batchRefineChanges).where(and(
    eq(batchRefineChanges.runId, input.runId),
    eq(batchRefineChanges.userId, input.userId),
    eq(batchRefineChanges.chapterIndex, input.chapterIndex),
  )).limit(1);
  return rows[0] || null;
}

export async function updateBatchRefineRunProgress(input: {
  runId: string;
  processedChapters: number;
  changedChapters: number;
  unchangedChapters: number;
  failedChapters: number;
}): Promise<void> {
  await db.update(batchRefineRuns).set({
    processedChapters: input.processedChapters,
    changedChapters: input.changedChapters,
    unchangedChapters: input.unchangedChapters,
    failedChapters: input.failedChapters,
    updatedAt: Date.now(),
  }).where(eq(batchRefineRuns.id, input.runId));
}

export async function finishBatchRefineRun(runId: string, status: 'completed' | 'cancelled' | 'error'): Promise<void> {
  await db.update(batchRefineRuns).set({
    status,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  }).where(eq(batchRefineRuns.id, runId));
}

export async function insertBatchRefineProposal(input: {
  runId: string;
  userId: string;
  documentId: string;
  chapterIndex: number;
  chapterTitle: string;
  textFileName: string;
  previousText: string;
  proposedText: string;
  metrics: BatchRefineMetrics;
}): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  await db.insert(batchRefineChanges).values({
    id,
    runId: input.runId,
    userId: input.userId,
    documentId: input.documentId,
    chapterIndex: input.chapterIndex,
    chapterTitle: input.chapterTitle,
    textFileName: input.textFileName,
    previousText: input.previousText,
    proposedText: input.proposedText,
    sourceTextHash: input.metrics.sourceTextHash,
    proposedTextHash: input.metrics.proposedTextHash,
    diffText: input.metrics.diffText,
    changedCharacters: input.metrics.changedCharacters,
    addedCharacters: input.metrics.addedCharacters,
    removedCharacters: input.metrics.removedCharacters,
    changePercent: input.metrics.changePercent,
    reviewPriority: input.metrics.reviewPriority,
    priorityScore: input.metrics.priorityScore,
    flagsJson: input.metrics.reviewFlags,
    reviewNote: input.metrics.reviewNote,
    decision: 'pending',
    audioStatus: 'not_requested',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function ownedChange(changeId: string, userId: string) {
  const rows = await db.select({
    change: batchRefineChanges,
    run: batchRefineRuns,
  }).from(batchRefineChanges)
    .innerJoin(batchRefineRuns, eq(batchRefineChanges.runId, batchRefineRuns.id))
    .where(and(
      eq(batchRefineChanges.id, changeId),
      eq(batchRefineChanges.userId, userId),
      eq(batchRefineRuns.userId, userId),
    ))
    .limit(1);
  return rows[0] || null;
}

export async function approveBatchRefineChange(input: {
  changeId: string;
  userId: string;
  editedText?: string;
  overrideSourceEvidence?: boolean;
  overrideIssueIds?: string[];
  recordingVoice?: string;
  overrideFullManualEdit?: boolean;
  skipJobIdleCheck?: boolean;
}): Promise<{ changeId: string; queued: boolean }> {
  const owned = await ownedChange(input.changeId, input.userId);
  if (!owned) throw new BatchRefineReviewConflictError('Batch Refine change not found.');
  if (owned.change.decision === 'rejected') {
    throw new BatchRefineReviewConflictError('This change was already rejected.');
  }
  if (owned.change.decision === 'approved' && owned.change.audioStatus !== 'error') {
    return { changeId: owned.change.id, queued: owned.change.audioStatus === 'queued' || owned.change.audioStatus === 'running' };
  }

  const proposedText = input.editedText === undefined ? owned.change.proposedText : input.editedText;
  const pronunciationRepair = owned.run.rule === PRONUNCIATION_REPAIR_RULE;
  if (pronunciationRepair) {
    const jobs = await db.select({ status: audiobookJobs.status }).from(audiobookJobs).where(and(eq(audiobookJobs.userId, input.userId), eq(audiobookJobs.documentId, owned.change.documentId)));
    if (!input.skipJobIdleCheck && jobs.some((job: { status: string }) => job.status === 'queued' || job.status === 'running')) throw new BatchRefineReviewConflictError('Pause background generation before approving pronunciation repairs.');
    await assertStoredPronunciationRepair({ bookId: owned.change.documentId, userId: input.userId, fileName: owned.change.textFileName, previous: owned.change.previousText, proposed: proposedText, allowSourceEvidenceOverride: input.overrideSourceEvidence === true, overrideIssueIds: input.overrideIssueIds, allowFullManualOverride: input.overrideFullManualEdit === true });
    if (/<voice\b/u.test(proposedText)) parseVoiceTaggedText(proposedText, { includeOmitted: true });
  }
  if (
    owned.run.profileCategory === 'scholar'
    && hasUntaggedScholarForeignScript(proposedText)
  ) {
    throw new BatchRefineReviewConflictError(
      'This Scholar text contains untagged Greek or Hebrew, or an editorial word split across pronunciation tags. Give each complete word one pronunciation tag or remove the term before recording.',
    );
  }
  const currentText = (await getAudiobookObjectBuffer(
    owned.change.documentId,
    input.userId,
    owned.change.textFileName,
    null,
  )).toString('utf8');
  const currentHash = batchRefineTextHash(currentText);
  if (pronunciationRepair && owned.change.textFileName.endsWith('__rejected.txt')) {
    const metadataName = owned.change.textFileName.replace('__rejected.txt', '__pronunciation_failure.json');
    const metadata = JSON.parse((await getAudiobookObjectBuffer(owned.change.documentId, input.userId, metadataName, null)).toString('utf8'));
    if (metadata.rejectedHash !== currentHash) throw new BatchRefineReviewConflictError('Rejected output changed after this proposal. Scan again.');
    const canonicalName = canonicalRepairTextFile(owned.change.textFileName);
    const objects = await listAudiobookObjects(owned.change.documentId, input.userId, null);
    const canonicalHash = objects.some(object => object.fileName === canonicalName)
      ? batchRefineTextHash((await getAudiobookObjectBuffer(owned.change.documentId, input.userId, canonicalName, null)).toString('utf8')) : null;
    if (canonicalHash !== metadata.canonicalHash && canonicalHash !== batchRefineTextHash(proposedText)) {
      throw new BatchRefineReviewConflictError('The saved chapter changed since generation failed. Scan the current chapter again.');
    }
  }
  if (currentHash !== owned.change.sourceTextHash && currentHash !== owned.change.proposedTextHash) {
    throw new BatchRefineReviewConflictError('The approved audiobook text changed after this proposal was created. Refresh the review before approving it.');
  }

  const edited = input.editedText !== undefined && input.editedText !== owned.change.proposedText;
  const metrics = calculateBatchRefineMetrics({
    category: owned.run.profileCategory as BatchRefineProfileCategory,
    previousText: owned.change.previousText,
    proposedText,
    aiPriority: owned.change.reviewPriority,
    aiFlags: owned.change.flagsJson,
    aiNote: owned.change.reviewNote,
    edited,
  });

  await putAudiobookObject(
    owned.change.documentId,
    input.userId,
    pronunciationRepair ? canonicalRepairTextFile(owned.change.textFileName) : owned.change.textFileName,
    Buffer.from(proposedText, 'utf8'),
    'text/plain; charset=utf-8',
    null,
  );

  const overrideNote = input.overrideSourceEvidence === true || input.overrideIssueIds?.length || input.overrideFullManualEdit
    ? `${owned.change.reviewNote || ''}${owned.change.reviewNote ? ' ' : ''}[Reviewer override: ${input.overrideFullManualEdit ? 'entire manual edit' : `source-evidence issue IDs=${input.overrideIssueIds?.length ? input.overrideIssueIds.join(',') : 'all'}`}; verify OCR/script corrections.]`
    : owned.change.reviewNote;
  await db.update(batchRefineChanges).set({
    proposedText,
    proposedTextHash: metrics.proposedTextHash,
    diffText: metrics.diffText,
    changedCharacters: metrics.changedCharacters,
    addedCharacters: metrics.addedCharacters,
    removedCharacters: metrics.removedCharacters,
    changePercent: metrics.changePercent,
    reviewPriority: metrics.reviewPriority,
    priorityScore: metrics.priorityScore,
    flagsJson: metrics.reviewFlags,
    reviewNote: reviewNoteWithRecordingVoice(overrideNote, validatedRecordingVoice(input.recordingVoice)),
    edited,
    decision: 'approved',
    audioStatus: 'queued',
    audioError: null,
    decidedAt: Date.now(),
    updatedAt: Date.now(),
  }).where(and(
    eq(batchRefineChanges.id, owned.change.id),
    eq(batchRefineChanges.userId, input.userId),
  ));

  return { changeId: owned.change.id, queued: true };
}

export async function rejectBatchRefineChange(changeId: string, userId: string): Promise<void> {
  const owned = await ownedChange(changeId, userId);
  if (!owned) throw new BatchRefineReviewConflictError('Batch Refine change not found.');
  if (owned.change.decision !== 'pending') {
    throw new BatchRefineReviewConflictError('Only a pending proposal can keep the previous text.');
  }
  const currentText = (await getAudiobookObjectBuffer(
    owned.change.documentId,
    userId,
    owned.change.textFileName,
    null,
  )).toString('utf8');
  const currentHash = batchRefineTextHash(currentText);
  if (currentHash !== owned.change.sourceTextHash && currentHash !== owned.change.proposedTextHash) {
    throw new BatchRefineReviewConflictError('The audiobook text changed after this proposal was created. Refresh before choosing Keep Previous.');
  }
  // A blob write can succeed immediately before a process interruption leaves
  // the database decision pending. Restore the durable previous text in that
  // narrow recovery case so Keep Previous always means what it says.
  if (currentHash === owned.change.proposedTextHash && currentHash !== owned.change.sourceTextHash) {
    await putAudiobookObject(
      owned.change.documentId,
      userId,
      owned.change.textFileName,
      Buffer.from(owned.change.previousText, 'utf8'),
      'text/plain; charset=utf-8',
      null,
    );
  }
  await db.update(batchRefineChanges).set({
    decision: 'rejected',
    audioStatus: 'not_requested',
    audioError: null,
    decidedAt: Date.now(),
    updatedAt: Date.now(),
  }).where(and(eq(batchRefineChanges.id, changeId), eq(batchRefineChanges.userId, userId)));
}

export async function reopenBatchRefineChange(changeId: string, userId: string): Promise<void> {
  const owned = await ownedChange(changeId, userId);
  if (!owned) throw new BatchRefineReviewConflictError('Batch Refine change not found.');
  if (owned.change.decision !== 'approved') {
    throw new BatchRefineReviewConflictError('Only an approved change can be reopened for correction.');
  }
  if (owned.change.audioStatus === 'queued' || owned.change.audioStatus === 'running') {
    throw new BatchRefineReviewConflictError('Wait for the current replacement recording to finish before reopening this repair.');
  }
  await db.update(batchRefineChanges).set({
    decision: 'pending',
    audioStatus: 'not_requested',
    audioError: null,
    decidedAt: null,
    updatedAt: Date.now(),
  }).where(and(eq(batchRefineChanges.id, changeId), eq(batchRefineChanges.userId, userId)));
}

export async function retryBatchRefineRecording(changeId: string, userId: string, recordingVoice?: string): Promise<void> {
  const owned = await ownedChange(changeId, userId);
  if (!owned) throw new BatchRefineReviewConflictError('Batch Refine change not found.');
  if (owned.change.decision !== 'approved' || owned.change.audioStatus !== 'error') {
    throw new BatchRefineReviewConflictError('Only failed approved recordings can be retried.');
  }
  const jobs = await db.select({ status: audiobookJobs.status }).from(audiobookJobs).where(and(
    eq(audiobookJobs.documentId, owned.change.documentId), eq(audiobookJobs.userId, userId),
  ));
  if (jobs.some((job: { status: string }) => ['running', 'queued', 'pausing'].includes(job.status))) {
    throw new BatchRefineReviewConflictError('Pause background generation and repair jobs before retrying recordings.');
  }
  await db.update(batchRefineChanges).set({
    audioStatus: 'queued',
    audioError: null,
    reviewNote: reviewNoteWithRecordingVoice(owned.change.reviewNote, validatedRecordingVoice(recordingVoice)),
    updatedAt: Date.now(),
  }).where(and(eq(batchRefineChanges.id, changeId), eq(batchRefineChanges.userId, userId),
    eq(batchRefineChanges.decision, 'approved'), eq(batchRefineChanges.audioStatus, 'error')));
}

export async function getBatchRefineReview(input: {
  userId: string;
  documentId: string;
  runId?: string | null;
}) {
  const runRows = await db.select().from(batchRefineRuns).where(and(
    eq(batchRefineRuns.userId, input.userId),
    eq(batchRefineRuns.documentId, input.documentId),
    ...(input.runId ? [eq(batchRefineRuns.id, input.runId)] : []),
  )).orderBy(desc(batchRefineRuns.createdAt)).limit(1);
  const run = runRows[0] || null;
  if (!run) return { run: null, changes: [], flagDefinitions: [], profileConfig: null, recordingOptions: BATCH_REFINE_RECORDING_OPTION_HELP };

  const changes = await db.select({
    id: batchRefineChanges.id,
    runId: batchRefineChanges.runId,
    chapterIndex: batchRefineChanges.chapterIndex,
    chapterTitle: batchRefineChanges.chapterTitle,
    textFileName: batchRefineChanges.textFileName,
    previousText: batchRefineChanges.previousText,
    proposedText: batchRefineChanges.proposedText,
    diffText: batchRefineChanges.diffText,
    changedCharacters: batchRefineChanges.changedCharacters,
    addedCharacters: batchRefineChanges.addedCharacters,
    removedCharacters: batchRefineChanges.removedCharacters,
    changePercent: batchRefineChanges.changePercent,
    reviewPriority: batchRefineChanges.reviewPriority,
    priorityScore: batchRefineChanges.priorityScore,
    flagsJson: batchRefineChanges.flagsJson,
    reviewNote: batchRefineChanges.reviewNote,
    decision: batchRefineChanges.decision,
    edited: batchRefineChanges.edited,
    audioStatus: batchRefineChanges.audioStatus,
    audioError: batchRefineChanges.audioError,
    createdAt: batchRefineChanges.createdAt,
    updatedAt: batchRefineChanges.updatedAt,
    decidedAt: batchRefineChanges.decidedAt,
    audioCompletedAt: batchRefineChanges.audioCompletedAt,
  }).from(batchRefineChanges)
    .where(and(eq(batchRefineChanges.runId, run.id), eq(batchRefineChanges.userId, input.userId)))
    .orderBy(asc(batchRefineChanges.chapterIndex));
  const category = run.profileCategory as BatchRefineProfileCategory;
  return {
    run,
    changes,
    flagDefinitions: batchRefineFlagDefinitions(category),
    profileConfig: BATCH_REFINE_PROFILE_REVIEW_CONFIG[category],
    recordingOptions: BATCH_REFINE_RECORDING_OPTION_HELP,
  };
}

export async function listPendingBatchRefineChanges(runId: string, userId: string) {
  return db.select().from(batchRefineChanges).where(and(
    eq(batchRefineChanges.runId, runId),
    eq(batchRefineChanges.userId, userId),
    eq(batchRefineChanges.decision, 'pending'),
  )).orderBy(asc(batchRefineChanges.chapterIndex));
}
