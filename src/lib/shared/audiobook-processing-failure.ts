/** Safe, provider-independent failure metadata. Raw errors remain in `cause`. */
export type AudiobookFailureCategory = 'provider_transient' | 'provider_configuration' | 'content_validation' | 'cancelled' | 'technical_unknown';
export interface AudiobookFailure {
  failureCategory: AudiobookFailureCategory;
  provider?: string;
  stage: string;
  httpStatus?: number;
  providerCode?: string;
  model?: string;
  attempts?: number;
  retryAfterMs?: number;
  chapterIndex?: number;
  errorType?: string;
  gpuState?: string;
}
export class AudiobookProcessingError extends Error {
  constructor(readonly failure: AudiobookFailure, cause?: unknown) {
    super(failureSummary(failure), { cause });
    this.name = 'AudiobookProcessingError';
  }
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
const safeIdentifier = (v: unknown): string | undefined => typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(v) ? v : undefined;
export function classifyAudiobookFailure(error: unknown, context: Partial<AudiobookFailure> & { stage: string; cancelled?: boolean }): AudiobookFailure {
  if (error instanceof AudiobookProcessingError) return { ...context, ...error.failure, chapterIndex: context.chapterIndex ?? error.failure.chapterIndex };
  const chain: Record<string, unknown>[] = [];
  let current: unknown = error;
  for (let i = 0; i < 6 && current && !chain.includes(record(current)); i++) {
    chain.push(record(current)); current = record(current).cause;
  }
  const objects = chain.flatMap(v => [v, record(v.response), record(v.error)]);
  const status = objects.flatMap(v => [v.httpStatus, v.status, v.statusCode, v.code]).find(v => typeof v === 'number' && Number.isInteger(v) && v >= 400 && v <= 599) as number | undefined;
  const code = objects.map(v => safeIdentifier(v.apiStatus ?? v.providerStatus ?? v.code)).find(Boolean);
  const name = record(error).name ?? objects.map(v => v.exceptionType).find(Boolean);
  const message = typeof record(error).message === 'string' ? record(error).message as string : '';
  // Compatibility only: old SDKs omit status metadata. Provider context is required.
  const legacyStatus = context.provider ? /(?:HTTP\s+|^)([45]\d{2})(?:\s+status code|\b)/i.exec(message)?.[1] : undefined;
  const httpStatus = status ?? (legacyStatus ? Number(legacyStatus) : undefined);
  let retryAfterMs = objects.map(v => v.retryAfterMs).find(v => typeof v === 'number' && Number.isFinite(v) && v > 0) as number | undefined;
  for (const obj of objects) {
    const headers = obj.headers as Headers | Record<string, string> | undefined;
    const value = headers && ('get' in headers && typeof headers.get === 'function' ? headers.get('retry-after') : (headers as Record<string, string>)['retry-after']);
    if (value) {
      const delay = Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - Date.now();
      if (Number.isFinite(delay) && delay > 0) retryAfterMs = Math.max(retryAfterMs ?? 0, delay);
    }
  }
  const temporary403 = httpStatus === 403 && code === 'RESOURCE_EXHAUSTED' && retryAfterMs !== undefined;
  let failureCategory: AudiobookFailureCategory = 'technical_unknown';
  if (context.cancelled || name === 'AudiobookJobStoppedError') failureCategory = 'cancelled';
  else if ([400, 401, 402, 403, 404, 422].includes(httpStatus ?? 0) && !temporary403) failureCategory = 'provider_configuration';
  else if (httpStatus === 429 || httpStatus === 408 || (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) || temporary403
    || ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT', 'UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED'].includes(code ?? '')
    || ['TimeoutError', 'APIConnectionError', 'APIConnectionTimeoutError', 'GeminiTtsTransportError', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout', 'PoolTimeout', 'ConnectError', 'ReadError', 'NetworkError'].includes(String(name))
    || (context.provider && name === 'AbortError')
    || (context.provider && /fetch failed|network timeout|Kokoro did not become ready before the startup timeout/i.test(message))) failureCategory = 'provider_transient';
  else if (context.failureCategory === 'content_validation') failureCategory = 'content_validation';
  return { failureCategory, provider: safeIdentifier(context.provider), stage: context.stage,
    httpStatus, providerCode: code ?? (context.provider && /Kokoro did not become ready before the startup timeout/i.test(message) ? 'KOKORO_STARTUP_TIMEOUT' : undefined), model: safeIdentifier(context.model), attempts: context.attempts,
    retryAfterMs, chapterIndex: context.chapterIndex, errorType: safeIdentifier(name) };
}
export function failureSummary(f: AudiobookFailure): string {
  const identity = [f.provider ?? 'Processing', f.model].filter(Boolean).join(' / ');
  const status = f.httpStatus ? ` (HTTP ${f.httpStatus})` : f.providerCode ? ` (${f.providerCode})` : '';
  if (f.failureCategory === 'provider_transient') return `${identity} temporarily unavailable${status} during ${f.stage}. Completed chapters are preserved.`;
  if (f.failureCategory === 'provider_configuration') return `${identity} configuration or access failure${status} during ${f.stage}. Check credentials, model access and billing, then retry missing chapters.`;
  if (f.failureCategory === 'cancelled') return 'Audiobook processing stopped by cancellation.';
  if (f.stage === 'legacy_chapter_mapping_verification') return 'Original chapter mapping could not be verified. Restore the retained source/chapter mapping before retrying; existing recordings are preserved.';
  if (f.stage === 'saved_review_text_requires_recording') return 'Saved Review Workspace text differs from the validated generation checkpoint. Record or resolve those edits in Review Workspace before retrying missing chapters.';
  if (f.failureCategory === 'content_validation') return `Chapter requires content review during ${f.stage}.`;
  return `Technical failure during ${f.stage}${status}. Inspect diagnostics, then retry missing chapters.`;
}
export interface ProviderRetry { failure: AudiobookFailure; count: number; nextAttemptAt: number; exhausted: boolean }
export const PROVIDER_RETRY_BUDGET = 6;
export function planProviderRetry(failure: AudiobookFailure, previous: ProviderRetry | undefined, now = Date.now()): ProviderRetry {
  // Count resets only when the failed operation actually recovers (or an explicit manual retry).
  const previousCount = typeof previous?.count === 'number' && Number.isFinite(previous.count) ? Math.max(0, Math.trunc(previous.count)) : 0;
  const count = Math.min(previousCount, PROVIDER_RETRY_BUDGET) + 1;
  const delay = Math.max(Math.min(300_000 * 2 ** Math.min(count - 1, 10), 3_600_000), failure.retryAfterMs ?? 0);
  return { failure, count, nextAttemptAt: Math.min(now + delay, Number.MAX_SAFE_INTEGER), exhausted: count > PROVIDER_RETRY_BUDGET };
}
