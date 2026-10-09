import { AudiobookProcessingError, classifyAudiobookFailure } from '@/lib/shared/audiobook-processing-failure';
import {
  discardInvalidSmartAudioPronunciationTags,
  SmartAudioOutputValidationError,
  SmartAudioSuspiciousOmissionError,
  forcefullyTransliterateUntaggedForeignText,
} from '@/lib/shared/smart-audio-cleanup';
import { resolveSmartAudioValidationRepairModel } from '@/lib/shared/smart-audio-models';

type WorkerRecord = Record<string, unknown>;

function throwIfRecoveryCancelled(error: unknown): void {
  if (!(error instanceof SmartAudioOutputValidationError)) throw error;
  if (error instanceof Error && ['AbortError', 'AudiobookJobStoppedError'].includes(error.name)) throw error;
}

export type SmartAudioValidationRecovery<T> = {
  result: T;
  workerResult: WorkerRecord;
  repairAttempted: boolean;
  fallbackUsed: boolean;
  sourceFallbackUsed: boolean;
  validationErrors: string[];
  discardedTags: number;
};

function workerRecord(value: unknown): WorkerRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as WorkerRecord
    : null;
}

function rejectedWorkerOutput(value: WorkerRecord): string {
  if (Array.isArray(value.segments)) {
    return JSON.stringify({
      segments: value.segments,
      continuity_state: value.continuity_state,
      chapter_title: value.chapter_title,
    });
  }
  return typeof value.cleaned_text === 'string' ? value.cleaned_text : '';
}

export function buildSmartAudioValidationRepairPayload(
  originalPayload: string,
  rejectedResult: unknown,
  validationError: SmartAudioOutputValidationError,
): string {
  const original = JSON.parse(originalPayload) as WorkerRecord;
  const rejected = workerRecord(rejectedResult) || {};
  const requestedModel = typeof original.ai_model === 'string' ? original.ai_model : undefined;
  return JSON.stringify({
    ...original,
    ai_model: resolveSmartAudioValidationRepairModel(requestedModel),
    repair_attempt: 1,
    validation_feedback: validationError.message,
    rejected_output: rejectedWorkerOutput(rejected),
  });
}

export function discardInvalidPronunciationsFromWorkerResult(
  value: unknown,
  authoritativePronunciations: Record<string, string>,
): { workerResult: WorkerRecord; discardedTags: number; errors: string[] } {
  const result = workerRecord(value);
  if (!result) {
    throw new SmartAudioOutputValidationError('Smart Audio worker returned an invalid response.');
  }

  let discardedTags = 0;
  const errors: string[] = [];
  const sanitize = (text: unknown): unknown => {
    if (typeof text !== 'string') return text;
    const fallback = discardInvalidSmartAudioPronunciationTags(
      text,
      authoritativePronunciations,
    );
    discardedTags += fallback.discardedTags;
    errors.push(...fallback.errors);
    return fallback.text;
  };

  if (Array.isArray(result.segments)) {
    return {
      workerResult: {
        ...result,
        segments: result.segments.map((segment) => (
          segment && typeof segment === 'object' && !Array.isArray(segment)
            ? { ...segment as WorkerRecord, text: sanitize((segment as WorkerRecord).text) }
            : segment
        )),
      },
      discardedTags,
      errors,
    };
  }

  return {
    workerResult: { ...result, cleaned_text: sanitize(result.cleaned_text) },
    discardedTags,
    errors,
  };
}


function transliterateUntaggedForeignTextInWorkerResult(value: unknown): WorkerRecord {
  const result = workerRecord(value);
  if (!result) throw new SmartAudioOutputValidationError('Invalid response.');
  
  const sanitize = (text: unknown): unknown => {
    if (typeof text !== 'string') return text;
    return forcefullyTransliterateUntaggedForeignText(text);
  };

  if (Array.isArray(result.segments)) {
    return {
      ...result,
      segments: result.segments.map((segment) => (
        segment && typeof segment === 'object' && !Array.isArray(segment)
          ? { ...segment as WorkerRecord, text: sanitize((segment as WorkerRecord).text) }
          : segment
      )),
    };
  }

  return { ...result, cleaned_text: sanitize(result.cleaned_text), tagged_text: sanitize(result.tagged_text) };
}

export async function resolveSmartAudioWithValidationRecovery<T>(input: {
  initialResult: unknown;
  resolve: (result: unknown) => T;
  requestRepair: (
    rejectedResult: unknown,
    validationError: SmartAudioOutputValidationError,
  ) => Promise<unknown>;
  sourceFallback?: (rejectedResult: unknown) => unknown;
  authoritativePronunciations: Record<string, string>;
  onUnrecoverable?: (result: WorkerRecord, errors: string[]) => Promise<void>;
  targetedRepair?: (result: unknown) => Promise<unknown>;
}): Promise<SmartAudioValidationRecovery<T>> {
  let targetedChanged = false;
  if (input.targetedRepair) {
    try {
      const repaired = await input.targetedRepair(input.initialResult);
      targetedChanged = repaired !== input.initialResult;
      input = { ...input, initialResult: repaired };
    } catch (error) {
      throwIfRecoveryCancelled(error);
      const rejected = workerRecord(input.initialResult);
      if (rejected && input.onUnrecoverable) await input.onUnrecoverable(rejected, [error instanceof Error ? error.message : 'Targeted repair failed.']);
      throw error;
    }
  }
  try {
    const result = input.resolve(input.initialResult);
    const strictWorkerResult = workerRecord(input.initialResult);
    if (!strictWorkerResult) {
      throw new SmartAudioOutputValidationError('Smart Audio worker returned an invalid response.');
    }
    return {
      result,
      workerResult: strictWorkerResult,
      repairAttempted: targetedChanged,
      fallbackUsed: false,
      sourceFallbackUsed: false,
      validationErrors: [],
      discardedTags: 0,
    };
  } catch (error) {
    if (!(error instanceof SmartAudioOutputValidationError)) throw error;
    const validationErrors = [error.message];
    const shouldPreserveSource = error instanceof SmartAudioSuspiciousOmissionError;
    let fallbackCandidate = input.initialResult;

    try {
      const response = await input.requestRepair(input.initialResult, error);
      const responseRecord = workerRecord(response);
      if (responseRecord && responseRecord.status !== 'success') {
        const diagnostic = workerRecord(responseRecord.diagnostic) ?? {};
        const failure = classifyAudiobookFailure({ ...diagnostic, cause: diagnostic.error, message: responseRecord.message }, { provider: 'gemini', stage: 'smart_audio_validation_repair' });
        if (responseRecord.status === 'rate_limit' && failure.httpStatus === undefined) failure.failureCategory = 'provider_transient';
        throw new AudiobookProcessingError(failure);
      }
      const repaired = input.targetedRepair ? await input.targetedRepair(response) : response;
      const repairedRecord = workerRecord(repaired);
      if (repairedRecord?.status === 'success') {
        fallbackCandidate = repaired;
        try {
          return {
            result: input.resolve(repaired),
            workerResult: repairedRecord,
            repairAttempted: true,
            fallbackUsed: false,
            sourceFallbackUsed: false,
            validationErrors,
            discardedTags: 0,
          };
        } catch (repairValidationError) {
          if (!(repairValidationError instanceof SmartAudioOutputValidationError)) {
            throw repairValidationError;
          }
          validationErrors.push(repairValidationError.message);
        }
      }
    } catch (repairRequestError) {
      throwIfRecoveryCancelled(repairRequestError);
      if (!(repairRequestError instanceof SmartAudioOutputValidationError)) {
        validationErrors.push(
          repairRequestError instanceof Error
            ? repairRequestError.message
            : 'Smart Audio correction request failed.',
        );
      }
    }

    if (input.targetedRepair) {
      // Source omission still has its established source fallback. Run that
      // text through the same pronunciation checks before the final validator;
      // do not strip or transliterate unresolved words to bypass a failure.
      if (shouldPreserveSource && input.sourceFallback) {
        const sourceCandidate = input.sourceFallback(fallbackCandidate);
        try {
          const repairedSource = workerRecord(await input.targetedRepair(sourceCandidate));
          if (!repairedSource) throw new SmartAudioOutputValidationError('Smart Audio source fallback returned an invalid response.');
          return { result: input.resolve(repairedSource), workerResult: repairedSource, repairAttempted: true,
            fallbackUsed: true, sourceFallbackUsed: true, validationErrors, discardedTags: 0 };
        } catch (sourceError) {
          throwIfRecoveryCancelled(sourceError);
          const rejected = workerRecord(sourceCandidate);
          if (rejected && input.onUnrecoverable) await input.onUnrecoverable(rejected, validationErrors);
          throw sourceError;
        }
      }
      const rejected = workerRecord(fallbackCandidate);
      if (rejected && input.onUnrecoverable) await input.onUnrecoverable(rejected, validationErrors);
      throw error;
    }
    const fallbackCandidates = fallbackCandidate === input.initialResult
      ? [fallbackCandidate]
      : [fallbackCandidate, input.initialResult];
    for (const candidate of fallbackCandidates) {
      const fallback = discardInvalidPronunciationsFromWorkerResult(
        candidate,
        input.authoritativePronunciations,
      );
      if (fallback.discardedTags === 0) continue;
      try {
        return {
          result: input.resolve(fallback.workerResult),
          workerResult: fallback.workerResult,
          repairAttempted: true,
          fallbackUsed: true,
          sourceFallbackUsed: false,
          validationErrors: [...validationErrors, ...fallback.errors],
          discardedTags: fallback.discardedTags,
        };
      } catch (fallbackValidationError) {
        if (!(fallbackValidationError instanceof SmartAudioOutputValidationError)) {
          throw fallbackValidationError;
        }
        validationErrors.push(fallbackValidationError.message);
      }
    }
    
    for (const candidate of fallbackCandidates) {
      try {
        const transliteratedResult = transliterateUntaggedForeignTextInWorkerResult(candidate);
        return {
          result: input.resolve(transliteratedResult),
          workerResult: transliteratedResult,
          repairAttempted: true,
          fallbackUsed: true,
          sourceFallbackUsed: false,
          validationErrors: [...validationErrors, "Forcefully transliterated untagged foreign text as a final fallback."],
          discardedTags: 0,
        };
      } catch {
        // ignore
      }
    }
    
    if (shouldPreserveSource && input.sourceFallback) {
      const sourceFallback = input.sourceFallback(fallbackCandidate);
      const sourceFallbackRecord = workerRecord(sourceFallback);
      if (!sourceFallbackRecord) {
        throw new SmartAudioOutputValidationError('Smart Audio source fallback returned an invalid response.');
      }
      return {
        result: input.resolve(sourceFallbackRecord),
        workerResult: sourceFallbackRecord,
        repairAttempted: true,
        fallbackUsed: true,
        sourceFallbackUsed: true,
        validationErrors,
        discardedTags: 0,
      };
    }
    if (input.onUnrecoverable) {
      const rejected = workerRecord(fallbackCandidate);
      if (rejected) await input.onUnrecoverable(rejected, validationErrors);
    }
    throw error;
  }
}
