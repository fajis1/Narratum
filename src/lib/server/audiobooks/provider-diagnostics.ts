export interface ProviderFailureDiagnostic {
  schemaVersion: 1;
  createdAt: string;
  jobId: string;
  bookId: string;
  chapterIndex: number;
  chapterTitle?: string;
  stage: string;
  workerMode: string;
  natsSubject?: string;
  requestedModel?: string;
  workerResponse: Record<string, unknown>;
}

const SECRET = /(api[_-]?key|authorization|private[_-]?key|cookie|token)\s*[:=]\s*[^\s,}]+|([?&]key=)[^&\s]+/giu;

/** Bound untrusted worker diagnostics and remove common credential forms before persistence. */
export function safeProviderDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return value.replace(SECRET, '$1[redacted]').replace(/Bearer\s+[^\s,}]+/giu, 'Bearer [redacted]').replace(/AIza[a-zA-Z0-9_-]{20,}|\bsk-[a-zA-Z0-9_-]{10,}\b/gu, '[redacted]').slice(0, 16_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeProviderDiagnosticValue(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/api[_-]?key|authorization|private[_-]?key|cookie|token/i.test(key))
      .slice(0, 80).map(([key, item]) => [key, safeProviderDiagnosticValue(item, depth + 1)]),
  );
  return String(value).slice(0, 2_000);
}

export function providerDiagnosticFileName(chapterIndex: number): string {
  return `${String(chapterIndex + 1).padStart(4, '0')}__provider_failure.json`;
}

/** Keep an unexpected exception useful without exporting the error object or headers. */
export function sanitizedFailureDetail(error: unknown, secrets: readonly string[] = []): string | undefined {
  let current = error;
  let message: string | undefined;
  for (let i = 0; i < 6 && current && typeof current === 'object'; i++) {
    const value = current as { message?: unknown; cause?: unknown };
    if (typeof value.message === 'string') message = value.message;
    if (!value.cause || value.cause === current) break;
    current = value.cause;
  }
  if (!message) return undefined;
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  return String(safeProviderDiagnosticValue(message)).slice(0, 2000);
}
