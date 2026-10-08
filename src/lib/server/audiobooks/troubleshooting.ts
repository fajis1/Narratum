import { createHash, randomUUID } from 'node:crypto';
import { getAudiobookObjectBuffer, listAudiobookObjects, putAudiobookObject } from './blobstore';
import { serverLogger } from '@/lib/server/logger';
import type { GeminiTtsDiagnostic } from '@/lib/server/smart-audio/gemini-tts-client';

/** Defense in depth: export manuscript and performance data, never credentials or audio payloads. */
export function sanitizeTroubleshooting(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeTroubleshooting);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) =>
      !/api.?key|authorization|cookie|password|secret|^token$|access.?token|refresh.?token|private.?key|credential|audioBuffer|^data$|^headers$|^url$/i.test(key),
    ).map(([key, item]) => [key, sanitizeTroubleshooting(item)]));
  }
  if (typeof value === 'string') return value
    .replace(/AIza[\w-]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]');
  return value;
}

export function createTtsAttemptRecorder(input: {
  bookId: string; userId: string; chapterIndex: number; jobId?: string;
  profileId?: string; namespace?: string | null;
}) {
  const attempts: unknown[] = [];
  let totalAttempts = 0;
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  return async (record: GeminiTtsDiagnostic & { segmentNumber: number; speaker: string }) => {
    totalAttempts += 1;
    attempts.push(sanitizeTroubleshooting(record));
    if (attempts.length > 2000) attempts.shift();
    // Persist after every attempt, including quota failures, before the job yields.
    try {
      await putAudiobookObject(input.bookId, input.userId,
        `${String(input.chapterIndex + 1).padStart(4, '0')}__tts_attempts-${runId}.json`,
        Buffer.from(JSON.stringify({ schemaVersion: 1, chapterIndex: input.chapterIndex,
          jobId: input.jobId ?? null, profileId: input.profileId, runId, startedAt,
          updatedAt: new Date().toISOString(), totalAttempts,
          truncated: totalAttempts > 2000, attempts })),
        'application/json; charset=utf-8', input.namespace ?? null);
    } catch {
      // A diagnostic storage outage must not cause a second, billable synthesis attempt.
      serverLogger.warn({ event: 'audiobook.troubleshooting.retention_failed',
        bookId: input.bookId, chapterIndex: input.chapterIndex }, 'Could not retain TTS troubleshooting data.');
    }
  };
}

export function isTroubleshootingArtifact(name: string): boolean {
  return /^(?:drama-director-failure-chapter-\d+\.json|\d+__(?:drama_segments|tts_attempts(?:-[a-zA-Z0-9-]+)?|provider_failure|pronunciation_failure)\.json|\d+__(?:text|rejected|changelog)\.txt|audiobook\.meta\.json)$/.test(name);
}

export async function collectTroubleshootingArtifacts(bookId: string, userId: string, namespace: string | null) {
  const objects = await listAudiobookObjects(bookId, userId, namespace);
  const artifacts: Array<{ fileName: string; lastModified: number; sha256: string; content: unknown }> = [];
  const unavailable: Array<{ fileName: string; reason: string }> = [];
  let bytes = 0;
  // Read sequentially to bound memory use for large books.
  for (const object of objects.filter((item) => isTroubleshootingArtifact(item.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    if (object.size > 8 * 1024 * 1024 || bytes + object.size > 32 * 1024 * 1024) {
      unavailable.push({ fileName: object.fileName, reason: 'Bundle size limit; download this artifact separately.' });
      continue;
    }
    try {
      const buffer = await getAudiobookObjectBuffer(bookId, userId, object.fileName, namespace);
      bytes += buffer.length;
      const raw = buffer.toString('utf8');
      let content: unknown = raw;
      if (object.fileName.endsWith('.json')) {
        try { content = JSON.parse(raw); } catch { /* Preserve malformed diagnostic JSON as text. */ }
      }
      artifacts.push({ fileName: object.fileName, lastModified: object.lastModified, sha256: createHash('sha256').update(buffer).digest('hex'), content: sanitizeTroubleshooting(content) });
    } catch {
      unavailable.push({ fileName: object.fileName, reason: 'Artifact could not be read; it may have been removed during generation.' });
    }
  }
  return { artifacts, unavailable };
}
