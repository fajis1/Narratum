import { publishGeminiRecoveryCooldown } from './gemini-recovery-context';
import type { GeminiErrorDetails } from './gemini-error-details';
import { serverLogger } from '@/lib/server/logger';
import { setTimeout as delay } from 'node:timers/promises';
import { geminiErrorDetails } from './gemini-error-details';

const BACKUP_ELIGIBLE_STATUSES = new Set([429, 402, 403, 500, 502, 503, 504]);
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

const sleep = async (ms: number, signal?: AbortSignal, details?: GeminiErrorDetails, model?: string) => {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  await publishGeminiRecoveryCooldown({
    reason: details && [429, 402, 403].includes(details.status) ? 'rate_limit' : details ? 'unavailable' : 'network',
    startedAt, retryAt: startedAt + ms, model, httpStatus: details?.status,
    serverDirected: Boolean(details?.retryAfterMs && details.retryAfterMs >= ms),
  });
  try {
    if (process.env.NODE_ENV !== 'test') await delay(Math.max(0, startedAt + ms - Date.now()), undefined, { signal });
    signal?.throwIfAborted();
  } finally {
    await publishGeminiRecoveryCooldown(null);
  }
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
  model?: string,
): Promise<Response> {
  let delayMs = customInitialDelayMs ?? INITIAL_DELAY_MS;
  const maskedKey = apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : 'Key';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal?.throwIfAborted();
    let cooldownDetails: GeminiErrorDetails | undefined;
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
      cooldownDetails = details;
      // Long server delays belong in the durable caller, not a sleeping request.
      if ((details.retryAfterMs || 0) > MAX_DELAY_MS) return response;
      delayMs = Math.max(delayMs, details.retryAfterMs || 0);

      if ([429, 402, 403].includes(response.status)) {
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

      const statusText = [429, 402, 403].includes(response.status) ? `rate-limited (HTTP ${response.status})` : `temporarily unavailable (HTTP ${response.status})`;
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
    await sleep(delayMs, signal, cooldownDetails, model);
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
    return { response: await fetchWithExponentialBackoff(backupApiKey, 'backup', input.request, input.onStatusUpdate, input.initialDelayMs, input.signal, input.maxAttempts, input.retryRateLimitedModels, input.maxOverloadAttempts, input.requestedModel), usedBackup: true };
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
    input.requestedModel,
  ); } catch (error) {
    input.signal?.throwIfAborted();
    if (!backupApiKey || backupApiKey === primaryApiKey || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
    await input.onStatusUpdate?.('Gemini network retries exhausted; trying the backup key.');
    return { response: await fetchWithExponentialBackoff(backupApiKey, 'backup', input.request, input.onStatusUpdate, input.initialDelayMs, input.signal, input.maxAttempts, input.retryRateLimitedModels, input.maxOverloadAttempts, input.requestedModel), usedBackup: true };
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
    input.requestedModel,
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

type GeminiModelFallbackReason = 'unavailable' | 'overloaded' | 'rate-limited' | 'transient';

async function getGeminiModelFallbackReason(
  response: Response,
): Promise<GeminiModelFallbackReason | null> {
  // A response reaches this point only after the configured retry policy for
  // its current key/model pair has been exhausted.
  if (response.status === 503) return 'overloaded';
  if ([429, 402, 403].includes(response.status)) return 'rate-limited';
  if ([500, 502, 504].includes(response.status)) return 'transient';
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
  let lastError: unknown;
  let nextDelayMs = Math.min(input.initialDelayMs ?? INITIAL_DELAY_MS, MAX_DELAY_MS);
  let pendingDelayMs = 0;
  let pendingDetails: GeminiErrorDetails | undefined;
  let pendingModel: string | undefined;
  const pacedRequest = async (apiKey: string, model?: string) => {
    if (pendingDelayMs > 0) {
      serverLogger.warn({ event: 'gemini.recovery.cooldown', model, nextDelaySeconds: Math.ceil(pendingDelayMs / 1000) }, 'Pacing Gemini recovery across retries, keys and models');
      await input.onStatusUpdate?.(`Gemini recovery cooldown: waiting ${Math.ceil(pendingDelayMs / 1000)}s before the next request.`);
      await sleep(pendingDelayMs, input.signal, pendingDetails, pendingModel);
    }
    pendingDelayMs = 0;
    pendingDetails = undefined;
    try {
      const response = await input.request(apiKey, model);
      if (BACKUP_ELIGIBLE_STATUSES.has(response.status)) {
        const details = await geminiErrorDetails(response);
        pendingDetails = details;
        pendingModel = model;
        // Never shorten a server-specified cooldown, even beyond our local cap.
        pendingDelayMs = Math.max(nextDelayMs, details.retryAfterMs ?? 0);
        nextDelayMs = Math.min(pendingDelayMs * 2, MAX_DELAY_MS);
      }
      return response;
    } catch (error) {
      pendingDetails = undefined;
      pendingModel = model;
      pendingDelayMs = nextDelayMs;
      nextDelayMs = Math.min(nextDelayMs * 2, MAX_DELAY_MS);
      throw error;
    }
  };

  const primaryApiKey = input.primaryApiKey.trim();
  const backupApiKey = (input.backupApiKey || '').trim();
  const keyChains: Array<{ apiKey: string; keyType: 'primary' | 'backup' }> = primaryApiKey
    ? [{ apiKey: primaryApiKey, keyType: 'primary' as const }]
    : backupApiKey
      ? [{ apiKey: backupApiKey, keyType: 'backup' as const }]
      : [{ apiKey: primaryApiKey, keyType: 'primary' as const }];
  if (primaryApiKey && backupApiKey && backupApiKey !== primaryApiKey) {
    keyChains.push({ apiKey: backupApiKey, keyType: 'backup' });
  }

  // Key is deliberately the outer loop. A backup credential must not be used
  // until every configured model has been attempted with the primary key.
  for (const [keyIndex, keyChain] of keyChains.entries()) {
    for (const [modelIndex, candidateModel] of models.entries()) {
      input.signal?.throwIfAborted();
      let result: { response: Response; usedBackup: boolean };
      try {
        const keyResult = await fetchGeminiWithKeyFallback({
          ...input,
          primaryApiKey: keyChain.apiKey,
          requestedModel: candidateModel,
          backupApiKey: undefined,
          maxOverloadAttempts: effectiveMaxOverloadAttempts,
          request: (apiKey) => input.retryRateLimitedModels ? pacedRequest(apiKey, candidateModel) : candidateModel
            ? input.request(apiKey, candidateModel)
            : input.request(apiKey),
        });
        result = { ...keyResult, usedBackup: keyChain.keyType === 'backup' };
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw error;
        lastError = error;
        const nextModel = models[modelIndex + 1];
        if (nextModel) {
          await input.onStatusUpdate?.(`Gemini network retries exhausted for ${candidateModel} on the ${keyChain.keyType} key. Trying ${nextModel} on the ${keyChain.keyType} key.`);
          continue;
        }
        break;
      }

      lastResult = result;
      const fallbackReason = await getGeminiModelFallbackReason(result.response);
      if (!fallbackReason) {
        return {
          ...result,
          requestedModel,
          usedModel: candidateModel,
          usedModelFallback: Boolean(requestedModel && candidateModel !== requestedModel),
        };
      }

      const nextModel = models[modelIndex + 1];
      if (!nextModel) break;
      const reasonText = fallbackReason === 'rate-limited'
        ? 'rate-limited after retries'
        : fallbackReason === 'overloaded'
          ? 'overloaded after retries'
          : fallbackReason === 'transient'
            ? 'temporarily unavailable after retries'
            : 'unavailable for this Gemini API project';
      const statusMessage = `${candidateModel} remained ${reasonText} on the ${keyChain.keyType} key. Trying ${nextModel} on the ${keyChain.keyType} key.`;
      serverLogger.warn({
        event: 'gemini.model.fallback',
        requestedModel,
        keyType: keyChain.keyType,
        currentModel: candidateModel,
        fallbackModel: nextModel,
        httpStatus: result.response.status,
        reason: fallbackReason,
      }, 'Falling back within a Gemini credential model chain');
      await input.onStatusUpdate?.(statusMessage);
    }

    const backupChain = keyChains[keyIndex + 1];
    if (keyChain.keyType === 'primary' && backupChain) {
      const startingModel = models[0] || 'the requested model';
      const backupMasked = backupChain.apiKey.length >= 4 ? `...${backupChain.apiKey.slice(-4)}` : 'Key';
      serverLogger.warn({
        event: 'gemini.failover.backup_key',
        backupMasked,
        requestedModel,
      }, 'Primary Gemini model chain exhausted; switching to the backup Gemini API key');
      await input.onStatusUpdate?.(`Primary Gemini model chain exhausted. Switching to the backup API key (${backupMasked}) and restarting with ${startingModel}.`);
    }
  }

  if (!lastResult && lastError) throw lastError;
  return {
    response: lastResult?.response || new Response(null, { status: 502 }),
    usedBackup: lastResult?.usedBackup || false,
    requestedModel,
    usedModel: models.at(-1),
    usedModelFallback: models.length > 1,
  };
}
