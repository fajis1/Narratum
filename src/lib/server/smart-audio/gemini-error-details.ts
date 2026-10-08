export type GeminiErrorDetails = { status: number; code?: number; apiStatus?: string; retryAfterMs?: number; quotaMetrics?: string[] };
export type GeminiPrivateErrorDetails = GeminiErrorDetails & { message?: string; fieldViolations?: Array<{ field: string; description: string }> };

/** Allowlisted fields only: no messages, request URLs, project IDs or raw bodies. */
export async function geminiErrorDetails(response: Response, now = Date.now()): Promise<GeminiErrorDetails> {
  const result: GeminiErrorDetails = { status: response.status };
  const header = response.headers.get('retry-after');
  if (header) {
    const ms = /^\d+(?:\.\d+)?$/u.test(header) ? Number(header) * 1000 : Date.parse(header) - now;
    if (Number.isFinite(ms) && ms >= 0) result.retryAfterMs = ms;
  }
  try {
    const body = await response.clone().json();
    const error = body?.error;
    if (typeof error?.code === 'number') result.code = error.code;
    if (typeof error?.status === 'string' && /^[A-Z_]{1,64}$/u.test(error.status)) result.apiStatus = error.status;
    for (const detail of Array.isArray(error?.details) ? error.details.slice(0, 20) : []) {
      if (detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && typeof detail.retryDelay === 'string' && /^\d+(?:\.\d+)?s$/u.test(detail.retryDelay)) {
        const ms = Number(detail.retryDelay.slice(0, -1)) * 1000;
        if (Number.isFinite(ms)) result.retryAfterMs = Math.max(result.retryAfterMs || 0, ms);
      }
      if (detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure') {
        result.quotaMetrics = (Array.isArray(detail.violations) ? detail.violations : [])
          .map((item: { quotaMetric?: unknown }) => item.quotaMetric)
          .filter((value: unknown): value is string => typeof value === 'string' && /^generativelanguage\.googleapis\.com\/[a-z_]{1,120}$/u.test(value)).slice(0, 20);
      }
    }
  } catch { /* HTML/network error bodies are deliberately not retained. */ }
  return result;
}

/** Private artifact fields only. Keep normal logs on the stricter allowlist above. */
export async function geminiPrivateErrorDetails(response: Response): Promise<GeminiPrivateErrorDetails> {
  const details: GeminiPrivateErrorDetails = await geminiErrorDetails(response);
  try {
    const error = (await response.clone().json() as { error?: Record<string, unknown> }).error;
    if (typeof error?.message === 'string') details.message = error.message.slice(0, 8_000);
    const violations: Array<{ field: string; description: string }> = [];
    for (const detail of Array.isArray(error?.details) ? error.details.slice(0, 20) : []) {
      if (detail?.['@type'] !== 'type.googleapis.com/google.rpc.BadRequest') continue;
      for (const violation of Array.isArray(detail.fieldViolations) ? detail.fieldViolations : []) {
        if (violations.length >= 20) break;
        if (typeof violation?.field === 'string' && typeof violation?.description === 'string') {
          violations.push({ field: violation.field.slice(0, 500), description: violation.description.slice(0, 2_000) });
        }
      }
    }
    if (violations.length) details.fieldViolations = violations;
  } catch { /* provider bodies can be HTML or absent */ }
  return details;
}
