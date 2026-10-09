import { clearRetrySchedule } from './retry-settings';
import { repairPronunciationText } from './pronunciation-repair-engine';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { PronunciationRepairError, pronunciationRepairErrorMessage, resolveRepairAiSelection, type RepairAiSelection } from './pronunciation-repair-config';
import { db } from '@/db';
import { adminSettings, audiobookJobs, audiobookChapters, batchRefineChanges, batchRefineRuns } from '@/db/schema';
import { getAudiobookObjectBuffer, headAudiobookObject, isMissingBlobError, listAudiobookObjects, putAudiobookObject } from './blobstore';
import { batchRefineTextHash, calculateBatchRefineMetrics } from './batch-refine-assessment';
import { createBatchRefineRun, insertBatchRefineProposal, finishBatchRefineRun, updateBatchRefineRunProgress, markBatchRefineRunStarted } from './batch-refine-review-store';
import { readSmartAudioProfilesDocument, findSmartAudioProfileById } from '@/lib/server/smart-audio-profiles';
import { globalPronunciationDefaults } from '@/lib/server/tts/global-pronunciation-library';
import { readBookLexicon } from '@/lib/server/smart-audio/book-lexicon';
import { resolveBatchRefineProfileCategory } from '@/lib/shared/batch-refine-review';
import { sanitizeRepairDiagnostics, PRONUNCIATION_REPAIR_PROMPT_VERSION, type RepairDiagnostics } from './pronunciation-repair-diagnostics';
import { assertPronunciationRepair, scanPronunciationIssues, PRONUNCIATION_REPAIR_RULE, type PronunciationPatch } from '@/lib/shared/pronunciation-issues';
import { serverLogger } from '@/lib/server/logger';

export async function assertPronunciationBookIdle(bookId: string, userId: string, ownJobId?: string): Promise<void> {
  const active = await db.select({ id: audiobookJobs.id }).from(audiobookJobs).where(and(
    eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, userId), inArray(audiobookJobs.status, ['running', 'queued']),
    ownJobId ? ne(audiobookJobs.id, ownJobId) : undefined,
  )).limit(1);
  if (active.length) throw new PronunciationRepairError('Pause background generation before proposing or approving pronunciation repairs.');
}

export async function pronunciationCatalog(bookId: string, userId: string) {
  const objects = await listAudiobookObjects(bookId, userId, null);
  const jobRows = await db.select({ id: audiobookJobs.id, status: audiobookJobs.status, settingsJson: audiobookJobs.settingsJson }).from(audiobookJobs)
    .where(and(eq(audiobookJobs.documentId, bookId), eq(audiobookJobs.userId, userId), inArray(audiobookJobs.status, ['error', 'paused'])));
  const jobs = jobRows.filter((job: { settingsJson?: unknown }) => {
    try {
      const settings = (typeof job.settingsJson === 'string' ? JSON.parse(job.settingsJson) : job.settingsJson) as { jobType?: string } | null;
      return settings?.jobType !== 'pronunciation-repair';
    } catch { return true; }
  }).map((job: { id: string; status: string }) => ({ id: job.id, status: job.status }));
  const recovered = new Set<number>();
  for (const object of objects.filter(item => /^\d{4,6}__recording_state\.json$/.test(item.fileName))) {
    const index = Number(object.fileName.split('__')[0]) - 1;
    const failureName = object.fileName.replace('__recording_state.json', '__pronunciation_failure.json');
    if (!objects.some(item => item.fileName === failureName)) continue;
    const receipt = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, object.fileName, null)).toString('utf8'));
    const failure = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, failureName, null)).toString('utf8'));
    if (typeof receipt.recordedAt === 'number' && receipt.recordedAt >= (failure.createdAt ?? 0)) recovered.add(index);
  }
  const chosen = new Map<number, { chapterIndex: number; fileName: string; failed: boolean; modified: number }>();
  for (const object of objects) {
    const match = /^(\d{1,6})__(text|rejected)\.txt$/u.exec(object.fileName);
    if (!match || Number(match[1]) < 1) continue;
    const chapterIndex = Number(match[1]) - 1;
    if (match[2] === 'rejected' && recovered.has(chapterIndex)) continue;
    const candidate = { chapterIndex, fileName: object.fileName, failed: match[2] === 'rejected', modified: object.lastModified };
    const current = chosen.get(chapterIndex);
    if (!current || candidate.modified > current.modified || (candidate.modified === current.modified && !candidate.failed)) chosen.set(chapterIndex, candidate);
  }
  // Keep repaired failures discoverable until the original job resumes, even
  // though approval has already written a newer canonical text object.
  for (const object of objects.filter(item => /^\d{1,6}__rejected\.txt$/u.test(item.fileName))) {
    const index = Number(object.fileName.split('__')[0]) - 1;
    if (recovered.has(index)) continue;
    if (chosen.get(index)?.failed) continue;
    const metadataName = object.fileName.replace('__rejected.txt', '__pronunciation_failure.json');
    if (!objects.some(item => item.fileName === metadataName)) continue;
    const metadata = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, metadataName, null)).toString('utf8'));
    if (jobs.some((job: { id: string }) => job.id === metadata.jobId)) chosen.set(index, { chapterIndex: index, fileName: object.fileName, failed: true, modified: object.lastModified });
  }
  return { chapters: [...chosen.values()].sort((a, b) => a.chapterIndex - b.chapterIndex), failedJobs: jobs };
}

export async function existingPronunciationRepair(bookId: string, userId: string, fileName: string, hash: string) {
  const rows = await db.select({ id: batchRefineChanges.id, runId: batchRefineChanges.runId, decision: batchRefineChanges.decision, audioStatus: batchRefineChanges.audioStatus,
    proposedText: batchRefineChanges.proposedText, proposedTextHash: batchRefineChanges.proposedTextHash, previousText: batchRefineChanges.previousText })
    .from(batchRefineChanges).innerJoin(batchRefineRuns, eq(batchRefineRuns.id, batchRefineChanges.runId)).where(and(
      eq(batchRefineChanges.userId, userId), eq(batchRefineChanges.documentId, bookId), eq(batchRefineChanges.textFileName, fileName),
      eq(batchRefineChanges.sourceTextHash, hash), eq(batchRefineRuns.rule, PRONUNCIATION_REPAIR_RULE),
      inArray(batchRefineChanges.decision, ['pending', 'approved']),
    )).orderBy(desc(batchRefineChanges.createdAt)).limit(1);
  return rows[0] || null;
}

export async function readPronunciationChapter(bookId: string, userId: string, fileName: string) {
  if (!/^[0-9]{1,6}__(?:text|rejected)\.txt$/u.test(fileName) || Number(fileName.split('__')[0]) < 1) throw new PronunciationRepairError('Invalid chapter text file.');
  // Read exact keys instead of listing the entire book again for each chapter.
  const readBounded = async (name: string, optional = false): Promise<string> => {
    try {
      const head = await headAudiobookObject(bookId, userId, name, null);
      if (head.contentLength > 1000000) throw new PronunciationRepairError('Chapter unavailable or too large for targeted repair.');
      const buffer = await getAudiobookObjectBuffer(bookId, userId, name, null);
      if (buffer.length > 1000000) throw new PronunciationRepairError('Chapter grew beyond the targeted repair limit.');
      return buffer.toString('utf8');
    } catch (error) {
      if (optional && isMissingBlobError(error)) return '';
      throw error;
    }
  };
  const text = await readBounded(fileName);
  const prefix = fileName.split('__')[0];
  const chapterIndex = Number(prefix) - 1;
  const failureName = `${prefix}__pronunciation_failure.json`;
  const failed = fileName.endsWith('__rejected.txt');
  let original = '';
  let jobId: string | undefined;
  let profileId: string | undefined;
  let title = `Chapter ${chapterIndex + 1}`;
  let failureError: string | undefined;
  if (failed) {
    const data = JSON.parse(await readBounded(failureName));
    if (data.rejectedHash !== batchRefineTextHash(text)) throw new PronunciationRepairError('Rejected output changed during capture. Retry the scan.');
    original = typeof data.sourceText === 'string' ? data.sourceText : '';
    jobId = typeof data.jobId === 'string' ? data.jobId : undefined;
    profileId = typeof data.profileId === 'string' ? data.profileId : undefined;
    title = typeof data.chapterTitle === 'string' ? data.chapterTitle : title;
    failureError = Array.isArray(data.errors) && typeof data.errors[0] === 'string' ? data.errors[0] : undefined;
  } else {
    original = await readBounded(`${prefix}__original.txt`, true);
  }
  return { text, original, jobId, profileId, title, chapterIndex, failed, failureError, hash: batchRefineTextHash(text) };
}

export async function pronunciationDictionary(userId: string, bookId: string, requestedProfileId?: string) {
  const profiles = await readSmartAudioProfilesDocument(userId);
  const profile = findSmartAudioProfileById(profiles, requestedProfileId || profiles.selectedProfileId);
  if (!profile) throw new PronunciationRepairError('Select a Smart Audio profile.');
  const rows = await db.select({ valueJson: adminSettings.valueJson }).from(adminSettings).where(eq(adminSettings.key, 'global_pronunciations')).limit(1);
  const lexicon = await readBookLexicon(userId, bookId);
  const bookWords = lexicon?.profileId === profile.id ? Object.fromEntries(Object.entries(lexicon.entries)
    .filter(([, entry]) => entry.pronunciation).map(([word, entry]) => [word, entry.pronunciation!])) : {};
  const globalWords = globalPronunciationDefaults(rows[0]?.valueJson || {});
  const provenance = Object.fromEntries([
    ...Object.keys(globalWords).map(word => [word, 'global-dictionary']),
    ...Object.keys(bookWords).map(word => [word, 'book-lexicon']),
    ...Object.keys(profile.pronunciations || {}).map(word => [word, 'profile-dictionary']),
  ]);
  return { profile, dictionary: { ...globalWords, ...bookWords, ...profile.pronunciations }, provenance };
}

type RepairInput = {
  bookId: string; userId: string; fileName: string; hash: string; profileId?: string; signal: AbortSignal; manualPatches?: PronunciationPatch[];
  ownJobId?: string; assertOwned?: () => Promise<void>;
  onDiagnostics?: (diagnostics: RepairDiagnostics) => void;
  retryRunId?: string; proposalHash?: string;
} & RepairAiSelection;

export async function proposePronunciationRepair(input: RepairInput) {
  const diagnostics: RepairDiagnostics = { version: 1, promptVersion: PRONUNCIATION_REPAIR_PROMPT_VERSION, stage: 'preparation', sourceHash: input.hash, aiRequested: false };
  const secrets = [process.env.GEMINI_API_KEY || '', process.env.BACKUP_GEMINI_API_KEY || ''];
  try { return await proposePronunciationRepairInternal(input, diagnostics, secrets); }
  catch (error) {
    diagnostics.validatorReason ||= pronunciationRepairErrorMessage(error);
    diagnostics.errorType = error instanceof PronunciationRepairError ? 'PronunciationRepairError'
      : error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'UnknownError';
    throw error;
  }
  finally { input.onDiagnostics?.(sanitizeRepairDiagnostics(diagnostics, secrets)); }
}

async function proposePronunciationRepairInternal(input: RepairInput, diagnostics: RepairDiagnostics, secrets: string[]) {
  input.signal.throwIfAborted();
  diagnostics.stage = 'book-idle-check';
  await assertPronunciationBookIdle(input.bookId, input.userId, input.ownJobId);
  diagnostics.stage = 'chapter-read';
  const chapter = await readPronunciationChapter(input.bookId, input.userId, input.fileName);
  if (chapter.hash !== input.hash) throw new PronunciationRepairError('Chapter changed since scanning. Scan again.');
  diagnostics.stage = 'proposal-lookup';
  const existing = await existingPronunciationRepair(input.bookId, input.userId, input.fileName, chapter.hash);
  if (input.retryRunId && (!existing || existing.runId !== input.retryRunId || existing.decision !== 'pending'
    || existing.proposedTextHash !== input.proposalHash)) throw new PronunciationRepairError('Proposal changed since scanning. Scan again before retrying unresolved findings.');
  if (existing && !input.retryRunId) return { runId: existing.runId, proposalAction: 'reused' as const, dictionaryRepairs: 0, aiRepairs: 0,
    unresolvedCount: scanPronunciationIssues(existing.proposedText || '').length };
  const baseline = chapter.text;
  if (existing && input.retryRunId) {
    diagnostics.stage = 'existing-proposal-validation';
    try {
      assertPronunciationRepair(baseline, existing.proposedText, { sourceText: chapter.original, allowRemaining: true });
    } catch (error) {
      diagnostics.validatorReason = error instanceof Error ? error.message : 'Existing proposal validation failed.';
      throw new PronunciationRepairError('The saved proposal failed validation before retrying. Review the exact reason in the repair report.');
    }
    chapter.text = existing.proposedText;
  }
  diagnostics.stage = 'profile-selection';
  const { profile, dictionary, provenance } = await pronunciationDictionary(input.userId, input.bookId, input.profileId || chapter.profileId);
  secrets.push(profile.geminiApiKey || '', profile.backupGeminiApiKey || '');
  const { proposedText, validPatches, aiIds, unresolved } = await repairPronunciationText({
    text: chapter.text, original: chapter.original, profile, dictionary, provenance,
    failedChapterReason: chapter.failed ? chapter.failureError : undefined,
    signal: input.signal, manualPatches: input.manualPatches,
    resolveAi: () => resolveRepairAiSelection(input.userId, { ...input, profileId: profile.id }),
  }, diagnostics, secrets);
  diagnostics.stage = 'save-proposal';
  input.signal.throwIfAborted();
  await input.assertOwned?.();
  await assertPronunciationBookIdle(input.bookId, input.userId, input.ownJobId);
  if ((await readPronunciationChapter(input.bookId, input.userId, input.fileName)).hash !== chapter.hash) throw new PronunciationRepairError('Chapter changed during repair. Scan again.');
  if (existing && input.retryRunId) {
    assertPronunciationRepair(baseline, proposedText, { sourceText: chapter.original, allowRemaining: true });
    const metrics = calculateBatchRefineMetrics({ category: resolveBatchRefineProfileCategory(profile), previousText: baseline, proposedText, aiPriority: 'high',
      aiNote: `${diagnostics.remainingFindings?.length || 0} unresolved passages after retry; review before recording.` });
    const updated = await db.update(batchRefineChanges).set({ proposedText, proposedTextHash: metrics.proposedTextHash,
      diffText: metrics.diffText, changedCharacters: metrics.changedCharacters, addedCharacters: metrics.addedCharacters,
      removedCharacters: metrics.removedCharacters, changePercent: metrics.changePercent, flagsJson: metrics.reviewFlags,
      reviewNote: metrics.reviewNote, reviewPriority: metrics.reviewPriority, priorityScore: metrics.priorityScore, updatedAt: Date.now() })
      .where(and(eq(batchRefineChanges.id, existing.id), eq(batchRefineChanges.userId, input.userId), eq(batchRefineChanges.documentId, input.bookId),
        eq(batchRefineChanges.decision, 'pending'), eq(batchRefineChanges.proposedTextHash, input.proposalHash!), eq(batchRefineChanges.sourceTextHash, input.hash)))
      .returning({ id: batchRefineChanges.id });
    if (!updated.length) throw new PronunciationRepairError('Proposal changed during repair. Rescan before retrying.');
    try {
      await putAudiobookObject(input.bookId, input.userId, `batch_refine_${existing.runId}.diff`, Buffer.from(metrics.diffText), 'text/plain; charset=utf-8', null);
    } catch {
      serverLogger.warn({ event: 'pronunciation.repair.diff_refresh_failed', runId: existing.runId }, 'Proposal saved; its downloadable diff could not be refreshed. Review the current proposal comparison.');
    }
    diagnostics.stage = 'complete';
    return { runId: existing.runId, proposalAction: 'updated' as const, dictionaryRepairs: validPatches.filter(patch => !aiIds.has(patch.id)).length,
      aiRepairs: validPatches.filter(patch => aiIds.has(patch.id)).length, unresolvedCount: diagnostics.remainingFindings?.length || 0 };
  }
  const runId = randomUUID();
  const category = resolveBatchRefineProfileCategory(profile);
  await createBatchRefineRun({ id: runId, jobId: `repair-${runId}`, userId: input.userId, documentId: input.bookId,
    profileId: profile.id, profileCategory: category, rule: PRONUNCIATION_REPAIR_RULE, recordingMode: 'review', holdHighPriority: true });
  try {
    await markBatchRefineRunStarted(runId, 1);
    const remaining = diagnostics.remainingFindings?.length || 0;
    const metrics = calculateBatchRefineMetrics({ category, previousText: chapter.text, proposedText, aiPriority: 'high', aiNote: `${remaining ? `NEEDS REVIEW: ${remaining} unresolved passages; recording blocked until corrected. ` : ''}${validPatches.length} targeted repairs; ${unresolved.length ? 'Gemini assisted' : 'dictionary/manual/formatting only'}. Source-supported OCR changes require review. Existing audio remains until replacement succeeds.` });
    await insertBatchRefineProposal({ runId, userId: input.userId, documentId: input.bookId, chapterIndex: chapter.chapterIndex,
      chapterTitle: chapter.title, textFileName: input.fileName, previousText: chapter.text, proposedText,
      metrics,
    });
    await putAudiobookObject(input.bookId, input.userId, `batch_refine_${runId}.diff`, Buffer.from(metrics.diffText), 'text/plain; charset=utf-8', null);
    await updateBatchRefineRunProgress({ runId, processedChapters: 1, changedChapters: 1, unchangedChapters: 0, failedChapters: 0 });
    await finishBatchRefineRun(runId, 'completed');
  } catch (error) { await finishBatchRefineRun(runId, 'error'); throw error; }
  diagnostics.stage = 'complete';
  return { runId, proposalAction: 'created' as const, dictionaryRepairs: validPatches.filter(patch => !aiIds.has(patch.id)).length, aiRepairs: validPatches.filter(patch => aiIds.has(patch.id)).length, unresolvedCount: diagnostics.remainingFindings?.length || 0 };
}

export async function resumeRepairedPronunciationJob(bookId: string, userId: string, fileName: string) {
  const chapter = await readPronunciationChapter(bookId, userId, fileName);
  if (!chapter.jobId) throw new PronunciationRepairError('No resumable background job is associated with this finding.');
  const repairs = await db.select({ id: batchRefineChanges.id, proposedTextHash: batchRefineChanges.proposedTextHash }).from(batchRefineChanges).where(and(
    eq(batchRefineChanges.userId, userId), eq(batchRefineChanges.documentId, bookId), eq(batchRefineChanges.textFileName, fileName),
    eq(batchRefineChanges.sourceTextHash, chapter.hash), eq(batchRefineChanges.decision, 'approved'), eq(batchRefineChanges.audioStatus, 'completed'),
  )).limit(1);
  if (!repairs.length) throw new PronunciationRepairError('Approve the repair and wait for its recording to complete before resuming generation.');
  const canonical = await readPronunciationChapter(bookId, userId, fileName.replace('__rejected.txt', '__text.txt'));
  if (canonical.hash !== repairs[0].proposedTextHash) throw new PronunciationRepairError('Chapter text changed after the repair recording. Review and record the latest text first.');
  const recorded = await db.select({ id: audiobookChapters.id }).from(audiobookChapters).where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId), eq(audiobookChapters.chapterIndex, chapter.chapterIndex))).limit(1);
  if (!recorded.length) throw new PronunciationRepairError('Approve the repair and wait for this chapter to finish recording before resuming generation.');
  await assertPronunciationBookIdle(bookId, userId);
  const updated = await db.update(audiobookJobs).set({ status: 'queued', error: null, updatedAt: Date.now(), startedAt: null, settingsJson: clearRetrySchedule() })
    .where(and(eq(audiobookJobs.id, chapter.jobId), eq(audiobookJobs.userId, userId), eq(audiobookJobs.documentId, bookId), inArray(audiobookJobs.status, ['error', 'paused']))).returning({ id: audiobookJobs.id });
  if (!updated.length) throw new PronunciationRepairError('The original job is no longer paused or failed.');
  return chapter.jobId;
}
