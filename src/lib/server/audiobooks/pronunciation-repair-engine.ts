import type { SmartAudioProfile } from '@/types/client';
import { PronunciationRepairError } from './pronunciation-repair-config';
import { resolvePronunciationAiModel } from '@/lib/shared/smart-audio-models';
import { fetchGeminiWithRateLimitFallback } from '../smart-audio/gemini-failover';
import { geminiErrorDetails, type GeminiErrorDetails } from '../smart-audio/gemini-error-details';
import { buildPronunciationRepairInstructions, CONTEXTUAL_REPAIR_INSTRUCTIONS, inspectRepairPatches, selectRepairCandidates, type RepairDiagnostics } from './pronunciation-repair-diagnostics';
import { scanPronunciationIssues, applyPronunciationPatches, assertPronunciationRepair, failedChapterReviewIssue, type PronunciationPatch } from '@/lib/shared/pronunciation-issues';
import { parseVoiceTaggedText } from '@/lib/shared/multi-voice';

export async function repairPronunciationText(input: {
  text: string; original: string; profile: SmartAudioProfile;
  dictionary: Record<string, string>; provenance?: Record<string, string>;
  signal: AbortSignal; manualPatches?: PronunciationPatch[];
  failedChapterReason?: string;
  resolveAi: () => Promise<{ primaryApiKey: string; backupApiKey: string; selection: { aiModel: string; fallbackModels?: string[] } }>;
}, diagnostics: RepairDiagnostics, secrets: string[] = []) {
  const { profile, dictionary } = input;
  const provenance = input.provenance || {};
  diagnostics.systemInstruction = `${buildPronunciationRepairInstructions(profile)}\n${CONTEXTUAL_REPAIR_INSTRUCTIONS}`;
  diagnostics.stage = 'scan';
  const scannedIssues = scanPronunciationIssues(input.text, dictionary);
  const forcedFailureIssue = !scannedIssues.length && input.failedChapterReason
    ? failedChapterReviewIssue(input.text, input.failedChapterReason)
    : null;
  const issues = forcedFailureIssue ? [forcedFailureIssue] : scannedIssues;
  if (!issues.length) throw new PronunciationRepairError('No pronunciation issues remain in this chapter.');
  if ((input.manualPatches || []).some(patch => !patch || typeof patch.id !== 'string' || typeof patch.replacement !== 'string')) throw new PronunciationRepairError('Invalid manual repair.');
  const manual = new Map((input.manualPatches || []).map(patch => [patch.id, patch.replacement]));
  if (manual.size !== (input.manualPatches || []).length || [...manual].some(([id, value]) => !issues.some(issue => issue.id === id) || typeof value !== 'string')) throw new PronunciationRepairError('Invalid manual repair.');
  const resolved = issues.map(issue => ({ ...issue, replacement: manual.has(issue.id) ? manual.get(issue.id) : issue.replacement }));
  const patches: PronunciationPatch[] = resolved.filter(issue => issue.replacement !== undefined).map(issue => ({ id: issue.id, replacement: issue.replacement! }));
  const unresolved = resolved.filter(issue => issue.replacement === undefined);
  const aiIds = new Set(unresolved.map(issue => issue.id));
  diagnostics.findingCount = issues.length;
  diagnostics.findings = inspectRepairPatches(input.text, issues, patches, aiIds);
  if (unresolved.length) {
    const { primaryApiKey, backupApiKey, selection } = await input.resolveAi();
    secrets.push(primaryApiKey, backupApiKey);
    diagnostics.stage = 'gemini-request';
    diagnostics.requestedModel = selection.aiModel;
    diagnostics.fallbackModels = selection.fallbackModels;
    diagnostics.attempts = [];
    if (!primaryApiKey && !backupApiKey) throw new PronunciationRepairError('Configure a Gemini key in the selected profile to repair findings without a dictionary match.');
    diagnostics.aiRequested = true;
    let pending = unresolved;
    // One correction request, only for unresolved findings. Good patches stay
    // at their original offsets and are never sent back for regeneration.
    for (let round = 0; round < 2 && pending.length; round += 1) {
    // Bounded retries across three models/two keys can spend ~59 minutes in
    // capped cooldowns alone. Cancellation still interrupts requests and waits.
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(75 * 60 * 1000)]);
    diagnostics.stage = round ? 'gemini-correction' : 'gemini-request';
    try {
    const { response, usedModel, usedBackup } = await fetchGeminiWithRateLimitFallback({
      primaryApiKey, backupApiKey, requestedModel: selection.aiModel, fallbackModels: selection.fallbackModels, signal, maxAttempts: 3, retryRateLimitedModels: true,
      request: async (key, model) => {
        const attempt = { model, keyRole: key === primaryApiKey ? 'primary' : 'backup', status: undefined as number | undefined, round: round + 1, errorDetails: undefined as GeminiErrorDetails | undefined };
        diagnostics.attempts!.push(attempt);
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || resolvePronunciationAiModel(profile))}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          systemInstruction: { parts: [{ text: diagnostics.systemInstruction! }] },
          contents: [{ role: 'user', parts: [{ text: JSON.stringify({ originalSource: input.original, chapterContext: input.text, findings: pending,
            ...(round ? { validationFeedback: diagnostics.findings?.filter(finding => pending.some(issue => issue.id === finding.id)).map(({ id, reasons }) => ({ id, reasons })) } : {}) }) }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
        });
        attempt.status = response.status;
        if (!response.ok) attempt.errorDetails = await geminiErrorDetails(response);
        return response;
      },
    });
    diagnostics.stage = 'gemini-response';
    diagnostics.httpStatus = response.status;
    diagnostics.usedModel = usedModel;
    diagnostics.usedBackup = usedBackup;
    if (!response.ok) {
      if ([429, 402, 403, 500, 502, 503, 504].includes(response.status)) {
        diagnostics.apiBlocked = true;
        const retryAfterMs = Math.max(300000, ...diagnostics.attempts!.filter(attempt => attempt.round === round + 1).map(attempt => attempt.errorDetails?.retryAfterMs || 0));
        diagnostics.nextAttemptAt = Date.now() + Math.min(retryAfterMs, Number.MAX_SAFE_INTEGER - Date.now());
      }
      throw new PronunciationRepairError(`Gemini repair failed (HTTP ${response.status}). No chapter text was changed.`);
    }
    let parsed;
    try {
      const body = await response.json();
      if (typeof body.responseId === 'string') diagnostics.responseId = body.responseId;
      if (typeof body.candidates?.[0]?.finishReason === 'string') diagnostics.finishReason = body.candidates[0].finishReason;
      parsed = JSON.parse(body?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    } catch {
      throw new PronunciationRepairError(`Gemini returned invalid JSON (HTTP ${response.status}). No chapter text was changed; retry or select another model.`);
    }
    diagnostics.stage = 'patch-coverage';
    const received: PronunciationPatch[] = Array.isArray(parsed?.patches) ? parsed.patches.filter((patch: unknown): patch is PronunciationPatch => Boolean(patch && typeof patch === 'object' && typeof (patch as PronunciationPatch).id === 'string')) : [];
    const receivedIds = received.map(patch => patch.id);
    diagnostics.missingIds = pending.filter(issue => !receivedIds.includes(issue.id)).map(issue => issue.id);
    diagnostics.duplicateIds = [...new Set(receivedIds.filter((id, index) => receivedIds.indexOf(id) !== index))];
    diagnostics.unexpectedIds = receivedIds.filter(id => !pending.some(issue => issue.id === id));
    const candidates = selectRepairCandidates(input.text, pending, received.filter(patch => !diagnostics.duplicateIds!.includes(patch.id) && !diagnostics.unexpectedIds!.includes(patch.id)), diagnostics, input.original, round + 1);
    diagnostics.findings = inspectRepairPatches(input.text, issues, [...patches, ...candidates], aiIds, input.original);
    (diagnostics.rounds ||= []).push({ round: round + 1, missingIds: diagnostics.missingIds, duplicateIds: diagnostics.duplicateIds,
      unexpectedIds: diagnostics.unexpectedIds, findings: diagnostics.findings, outcome: 'response_received' });
    for (const patch of candidates) {
      if (diagnostics.findings.find(finding => finding.id === patch.id)?.reasons.length === 0) patches.push(patch);
    }
    pending = pending.filter(issue => !patches.some(patch => patch.id === issue.id));
    } catch (error) {
      input.signal.throwIfAborted();
      if (!(error instanceof PronunciationRepairError) || signal.aborted) {
        diagnostics.apiBlocked = true;
        diagnostics.nextAttemptAt = Date.now() + 300000;
      }
      // Invalid JSON is retried once. Exhausted transport failures do not
      // restart the full transport budget; retain other valid repairs.
      diagnostics.validatorReason = error instanceof PronunciationRepairError ? error.message : 'Gemini request failed after transport retries.';
      (diagnostics.requestErrors ||= []).push({ round: round + 1, reason: diagnostics.validatorReason });
      (diagnostics.rounds ||= []).push({ round: round + 1, outcome: diagnostics.apiBlocked ? 'api_blocked' : 'request_failed' });
      if (!(error instanceof PronunciationRepairError && error.message.includes('invalid JSON')) || round === 1) break;
    }
    }
  }
  let proposedText: string;
  const checks = inspectRepairPatches(input.text, issues, patches, aiIds, input.original);
  diagnostics.findings = checks.map(finding => ({ ...finding,
    replacement: finding.replacement ?? diagnostics.findings?.find(old => old.id === finding.id)?.replacement,
    dictionaryWord: issues.find(issue => issue.id === finding.id)?.dictionaryWord,
    dictionarySource: provenance[issues.find(issue => issue.id === finding.id)?.dictionaryWord || ''],
    dictionaryPronunciation: dictionary[issues.find(issue => issue.id === finding.id)?.dictionaryWord || ''],
    source: manual.has(finding.id) ? 'manual' : aiIds.has(finding.id) ? 'gemini' : provenance[issues.find(issue => issue.id === finding.id)?.dictionaryWord || ''] || 'formatting',
    reasons: finding.reasons.length && diagnostics.findings?.find(old => old.id === finding.id)?.reasons.length
      ? diagnostics.findings.find(old => old.id === finding.id)!.reasons : finding.reasons,
  }));
  for (const finding of diagnostics.findings) {
    if (!finding.reasons.length) { finding.outcome = 'resolved'; continue; }
    const rejected = diagnostics.candidateChecks?.filter(check => check.id === finding.id && !check.selected);
    if (rejected?.length) {
      finding.outcome = 'candidate_rejected';
      finding.reasons = [...new Set(rejected.flatMap(check => check.reasons))];
      finding.replacement = rejected.at(-1)?.replacement;
      if (finding.reasons.some(reason => reason.includes('source evidence') || reason.includes('unrelated English') && /mixed-script|bare IPA|nested/iu.test(finding.scanReason))) {
        finding.outcome = 'source_evidence_missing';
        finding.reasons.push('No accepted source-supported reconstruction was established.');
      }
    } else if (diagnostics.apiBlocked && aiIds.has(finding.id)) {
      finding.outcome = 'api_blocked';
      finding.reasons = ['No usable replacement obtained because the Gemini request was blocked. This does not establish linguistic ambiguity.'];
    } else finding.outcome = aiIds.has(finding.id) ? 'model_omitted' : 'unresolved_after_validation';
  }
  const validPatches = patches.filter(patch => checks.find(finding => finding.id === patch.id)?.reasons.length === 0);
  if (!validPatches.length) {
    diagnostics.validatorReason ||= diagnostics.findings.find(finding => finding.reasons.length)?.reasons.join(' ');
    throw new PronunciationRepairError(diagnostics.apiBlocked ? 'Gemini API blocked; no usable candidates received for the unresolved findings. Saved proposals are retained.' : diagnostics.validatorReason?.includes('invalid JSON') ? diagnostics.validatorReason : 'No safe repairs were found. Review the unresolved findings in the repair report.');
  }
  try {
    diagnostics.stage = 'patch-application';
    proposedText = applyPronunciationPatches(input.text, issues, validPatches, { sourceText: input.original });
    diagnostics.stage = 'chapter-validation';
    diagnostics.remainingFindings = scanPronunciationIssues(proposedText).map(({ start, end, text, reason, kind }) => ({ start, end, text, reason, issueKind: kind }));
    assertPronunciationRepair(input.text, proposedText, { sourceText: input.original, allowRemaining: true });
    if (!diagnostics.remainingFindings.length) {
      assertPronunciationRepair(input.text, proposedText, { sourceText: input.original });
      delete diagnostics.validatorReason; // Recovered request errors remain in requestErrors.
    }
  } catch (error) {
    diagnostics.validatorReason = error instanceof Error ? error.message : 'Unknown validator failure';
    throw new PronunciationRepairError('The proposed patches failed pronunciation or unchanged-text validation. Review the flagged passages and enter manual replacements.');
  }
  diagnostics.stage = 'voice-validation';
  try { if (/<voice\b/u.test(proposedText)) parseVoiceTaggedText(proposedText, { includeOmitted: true }); }
  catch (error) { diagnostics.validatorReason = error instanceof Error ? error.message : 'Voice validation failed'; throw error; }
  return { proposedText, validPatches, aiIds, unresolved };
}
