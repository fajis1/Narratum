import { serverLogger } from '@/lib/server/logger';
import { setTimeout as delay } from 'node:timers/promises';
import { geminiErrorDetails } from './gemini-error-details';

const BACKUP_ELIGIBLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 8;
const INITIAL_DELAY_MS = 4000;
const MAX_DELAY_MS = 300000; // 5 minutes

export const GEMINI_MODEL_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  'gemini-3.8-flash': ['gemini-3.7-flash', 'gemini-3.6-flash'],
  'gemini-3.7-flash': ['gemini-3.6-flash', 'gemini-3.5-flash'],
  'gemini-3.6-flash': ['gemini-3.5-flash'],
  'gemini-3.5-flash': ['gemini-2.5-flash'],
  'gemini-3.5-flash-lite': ['gemini-3.1-flash-lite'],
  'gemini-3.1-flash-lite': ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  'gemini-2.5-flash-lite': ['gemini-2.5-flash'],
};

const sleep = async (ms: number, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  if (process.env.NODE_ENV !== 'test') await delay(ms, undefined, { signal });
  signal?.throwIfAborted();
};

export interface GeminiFallbackOptions {
  primaryApiKey: string;
  backupApiKey?: string | null;
  requestedModel?: string;
  fallbackModels?: readonly string[];
  /** Opt in to quota retries/model fallback with shared, capped recovery pacing. */
  retryRateLimitedModels?: boolean;
  request: (apiKey: string, model?: string) => Promise<Response>;
  onStatusUpdate?: (statusMessage: string) => Promise<void> | void;
  initialDelayMs?: number;
  signal?: AbortSignal;
  maxAttempts?: number;
  /**
   * Maximum retry attempts on HTTP 503 before failing over to the backup key, next model,
   * or alternative provider. Defaults to 2 when fallbacks (models or providers) exist.
   */
  maxOverloadAttempts?: number;
  /** Set to true when an alternative provider (e.g. Groq) is configured for failover. */
  hasAlternativeProvider?: boolean;
}

async function fetchWithExponentialBackoff(
  apiKey: string,
  keyType: 'primary' | 'backup',
  request: (apiKey: string) => Promise<Response>,
  onStatusUpdate?: (statusMessage: string) => Promise<void> | void,
  customInitialDelayMs?: number,
  signal?: AbortSignal,
  maxAttempts = MAX_ATTEMPTS,
  retryQuotaErrors = false,
  maxOverloadAttempts?: number,
): Promise<Response> {
  let delayMs = customInitialDelayMs ?? INITIAL_DELAY_MS;
  const maskedKey = apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : 'Key';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const response = await request(apiKey);
      if (!BACKUP_ELIGIBLE_STATUSES.has(response.status) || attempt === maxAttempts) {
        return response;
      }
      if (response.status === 503 && maxOverloadAttempts !== undefined && attempt >= maxOverloadAttempts) {
        serverLogger.warn({
          event: 'gemini.overload.fast_failover',
          keyType,
          maskedKey,
          httpStatus: response.status,
          attempt,
          maxOverloadAttempts,
        }, 'Gemini model/server overloaded (HTTP 503); failing over early instead of exhausting exponential backoff');
        return response;
      }
      // Opt-in callers pace every request, including key/model transitions.
      if (retryQuotaErrors) continue;
      const details = await geminiErrorDetails(response);
      // Long server delays belong in the durable caller, not a sleeping request.
      if ((details.retryAfterMs || 0) > MAX_DELAY_MS) return response;
      delayMs = Math.max(delayMs, details.retryAfterMs || 0);

      if (response.status === 429) {
        try {
          const bodyStr = await response.clone().text();
          const lowerBody = bodyStr.toLowerCase();
          if (lowerBody.includes('quota') || lowerBody.includes('spending cap') || lowerBody.includes('billing')) {
            return response;
          }
        } catch {
          // ignore
        }
      }

      const statusText = response.status === 429 ? 'rate-limited (HTTP 429)' : `temporarily unavailable (HTTP ${response.status})`;
      const delaySeconds = Math.round(delayMs / 1000);
      const effectiveAttempts = (response.status === 503 && maxOverloadAttempts !== undefined)
        ? maxOverloadAttempts
        : maxAttempts;
      const msg = `Gemini API ${statusText}. Retrying ${keyType} key (${maskedKey}) in ${delaySeconds}s (Attempt ${attempt}/${effectiveAttempts})...`;

      serverLogger.warn({
        event: 'gemini.rate_limit.retry',
        keyType,
        maskedKey,
        httpStatus: response.status,
        attempt,
        maxAttempts,
        nextDelaySeconds: delaySeconds,
      }, 'Retrying Gemini request after a transient HTTP response');

      if (onStatusUpdate) {
        await onStatusUpdate(msg);
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
      if (attempt === maxAttempts) throw error;
      if (retryQuotaErrors) continue;
      const delaySeconds = Math.round(delayMs / 1000);
      const msg = `Gemini network error. Retrying ${keyType} key (${maskedKey}) in ${delaySeconds}s (Attempt ${attempt}/${maxAttempts})...`;

      serverLogger.warn({
        event: 'gemini.network_error.retry',
        keyType,
        maskedKey,
        attempt,
        maxAttempts,
        nextDelaySeconds: delaySeconds,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }, 'Retrying Gemini request after a network error');

      if (onStatusUpdate) {
        await onStatusUpdate(msg);
      }
    }
    await sleep(delayMs, signal);
    delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
  }
  return request(apiKey);
}

async function fetchGeminiWithKeyFallback(
  input: GeminiFallbackOptions,
): Promise<{ response: Response; usedBackup: boolean; primaryStatus?: number }> {
  const primaryApiKey = input.primaryApiKey.trim();
  const backupApiKey = (input.backupApiKey || '').trim();
  input.signal?.throwIfAborted();
  if (!primaryApiKey && backupApiKey) {
    return { response: await fetchWithExponentialBackoff(backupApiKey, 'backup', input.request, input.onStatusUpdate, input.initialDelayMs, input.signal, input.maxAttempts, input.retryRateLimitedModels, input.maxOverloadAttempts), usedBackup: true };
  }

  let primaryResponse: Response;
  try { primaryResponse = await fetchWithExponentialBackoff(
    primaryApiKey,
    'primary',
    input.request,
    input.onStatusUpdate,
    input.initialDelayMs,
    input.signal,
    input.maxAttempts,
    input.retryRateLimitedModels,
    input.maxOverloadAttempts,
  ); } catch (error) {
    input.signal?.throwIfAborted();
    if (!backupApiKey || backupApiKey === primaryApiKey || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
    await input.onStatusUpdate?.('Gemini network retries exhausted; trying the backup key.');
    return { response: await fetchWithExponentialBackoff(backupApiKey, 'backup', input.request, input.onStatusUpdate, input.initialDelayMs, input.signal, input.maxAttempts, input.retryRateLimitedModels, input.maxOverloadAttempts), usedBackup: true };
  }

  if (
    !BACKUP_ELIGIBLE_STATUSES.has(primaryResponse.status)
    || !backupApiKey
    || backupApiKey === primaryApiKey
  ) {
    return { response: primaryResponse, usedBackup: false };
  }

  const backupMasked = backupApiKey.length >= 4 ? `...${backupApiKey.slice(-4)}` : 'Key';
  const failoverMsg = `Primary Gemini key exhausted (HTTP ${primaryResponse.status}). Switching to Backup key (${backupMasked})...`;

  serverLogger.warn({
    event: 'gemini.failover.backup_key',
    primaryHttpStatus: primaryResponse.status,
    backupMasked,
  }, 'Switching to the backup Gemini API key');

  if (input.onStatusUpdate) {
    await input.onStatusUpdate(failoverMsg);
  }

  const backupResponse = await fetchWithExponentialBackoff(
    backupApiKey,
    'backup',
    input.request,
    input.onStatusUpdate,
    input.initialDelayMs,
    input.signal,
    input.maxAttempts,
    input.retryRateLimitedModels,
    input.maxOverloadAttempts,
  );

  return {
    response: backupResponse,
    usedBackup: true,
    primaryStatus: primaryResponse.status,
  };
}

export async function isGeminiModelUnavailableResponse(response: Response): Promise<boolean> {
  if (response.ok || (response.status !== 400 && response.status !== 404)) return false;
  const body = await response.clone().text().catch(() => '');
  const normalized = body.toLowerCase();
  if (response.status === 404 && normalized.length === 0) return true;
  return normalized.includes('model_not_found')
    || normalized.includes('model not found')
    || normalized.includes('model does not exist')
    || normalized.includes('model is not available')
    || normalized.includes('model is not supported')
    || normalized.includes('unsupported model')
    || /models?\/[\w.-]+[^\n]{0,120}(?:not found|not supported|not available)/i.test(body);
}

type GeminiModelFallbackReason = 'unavailable' | 'overloaded';

async function getGeminiModelFallbackReason(
  response: Response,
): Promise<GeminiModelFallbackReason | null> {
  // A 503 only reaches this point after the retry and backup-key policy for the
  // current model has been exhausted, so it represents sustained overload for
  // this request rather than a single transient response.
  if (response.status === 503) return 'overloaded';
  if (await isGeminiModelUnavailableResponse(response)) return 'unavailable';
  return null;
}

export async function fetchGeminiWithRateLimitFallback(
  input: GeminiFallbackOptions,
): Promise<{
  response: Response;
  usedBackup: boolean;
  requestedModel?: string;
  usedModel?: string;
  usedModelFallback: boolean;
}> {
  const requestedModel = input.requestedModel?.trim() || undefined;
  const models: Array<string | undefined> = requestedModel
    ? [...new Set([requestedModel, ...(input.fallbackModels ?? GEMINI_MODEL_FALLBACKS[requestedModel] ?? [])])]
    : [undefined];
  const hasFallback = models.length > 1 || Boolean(input.hasAlternativeProvider);
  const effectiveMaxOverloadAttempts = input.maxOverloadAttempts
    ?? (input.maxAttempts !== undefined ? input.maxAttempts : (hasFallback ? 2 : undefined));
  let lastResult: { response: Response; usedBackup: boolean } | null = null;
  let backupBlocked = false;
  let nextDelayMs = Math.min(input.initialDelayMs ?? INITIAL_DELAY_MS, MAX_DELAY_MS);
  let pendingDelayMs = 0;
  const pacedRequest = async (apiKey: string, model?: string) => {
    if (pendingDelayMs > 0) {
      serverLogger.warn({ event: 'gemini.recovery.cooldown', model, nextDelaySeconds: Math.ceil(pendingDelayMs / 1000) }, 'Pacing Gemini recovery across retries, keys and models');
      await input.onStatusUpdate?.(`Gemini recovery cooldown: waiting ${Math.ceil(pendingDelayMs / 1000)}s before the next request.`);
      await sleep(pendingDelayMs, input.signal);
    }
    pendingDelayMs = 0;
    try {
      const response = await input.request(apiKey, model);
      if (BACKUP_ELIGIBLE_STATUSES.has(response.status)) {
        const details = await geminiErrorDetails(response);
        // Never shorten a server-specified cooldown, even beyond our local cap.
        pendingDelayMs = Math.max(nextDelayMs, details.retryAfterMs ?? 0);
        nextDelayMs = Math.min(pendingDelayMs * 2, MAX_DELAY_MS);
      }
      return response;
    } catch (error) {
      pendingDelayMs = nextDelayMs;
      nextDelayMs = Math.min(nextDelayMs * 2, MAX_DELAY_MS);
      throw error;
    }
  };

  for (const candidateModel of models) {
    input.signal?.throwIfAborted();
    const result = await fetchGeminiWithKeyFallback({
      ...input,
      maxOverloadAttempts: effectiveMaxOverloadAttempts,
      backupApiKey: backupBlocked ? undefined : input.backupApiKey,
      request: (apiKey) => input.retryRateLimitedModels ? pacedRequest(apiKey, candidateModel) : candidateModel
        ? input.request(apiKey, candidateModel)
        : input.request(apiKey),
    });
    lastResult = result;
    // A rate-limited backup must not erase evidence that the primary model
    // exhausted its overload retries. Try the next configured model on the
    // primary, without retrying that blocked backup again in this call.
    if (result.usedBackup && result.response.status === 429 && input.primaryApiKey.trim()) backupBlocked = true;
    const fallbackReason = input.retryRateLimitedModels && result.response.status === 429
      ? 'rate-limited' : result.primaryStatus === 503 && result.response.status === 429
      ? 'overloaded' : await getGeminiModelFallbackReason(result.response);
    if (!fallbackReason) {
      return {
        ...result,
        requestedModel,
        usedModel: candidateModel,
        usedModelFallback: Boolean(requestedModel && candidateModel !== requestedModel),
      };
    }

    const nextIndex = models.indexOf(candidateModel) + 1;
    const nextModel = models[nextIndex];
    if (!nextModel) break;
    const statusMessage = fallbackReason === 'rate-limited'
      ? `${candidateModel} remained rate-limited after retries. Trying ${nextModel} after the recovery cooldown.`
      : fallbackReason === 'overloaded'
      ? `${candidateModel} remained overloaded after retries. Using ${nextModel} for this request.`
      : `${candidateModel} is unavailable for this Gemini API project. Using ${nextModel} for this request.`;
    if (fallbackReason === 'overloaded') {
      serverLogger.warn({
        event: 'gemini.model.fallback',
        requestedModel,
        overloadedModel: candidateModel,
        fallbackModel: nextModel,
        httpStatus: result.response.status,
        reason: fallbackReason,
      }, 'Falling back from an overloaded Gemini model');
    } else {
      serverLogger.warn({
        event: 'gemini.model.fallback',
        requestedModel,
        unavailableModel: candidateModel,
        fallbackModel: nextModel,
        httpStatus: result.response.status,
        reason: fallbackReason,
      }, 'Falling back from an unavailable or rate-limited Gemini model');
    }
    await input.onStatusUpdate?.(statusMessage);
  }

  return {
    response: lastResult?.response || new Response(null, { status: 502 }),
    usedBackup: lastResult?.usedBackup || false,
    requestedModel,
    usedModel: models.at(-1),
    usedModelFallback: models.length > 1,
  };
}
