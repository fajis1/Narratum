import { putAudiobookObject } from './blobstore';
import type { DramaSynthesisReviewFlag } from '@/lib/server/smart-audio/drama-cloud-synthesis';

export async function saveDramaTtsDiagnostic(input: {
  bookId: string;
  userId: string;
  chapterIndex: number;
  flags: readonly DramaSynthesisReviewFlag[];
  namespace?: string | null;
}): Promise<void> {
  const failures = input.flags.filter((flag) => flag.kind === 'cloud-tts-failed');
  if (!failures.length) return;
  const fileName = `${String(input.chapterIndex + 1).padStart(4, '0')}__provider_failure.json`;
  // Only copy internally generated fields; API keys and raw upstream payloads
  // must never enter this downloadable artifact.
  const body = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    chapterIndex: input.chapterIndex,
    stage: 'gemini-drama-tts',
    failures: failures.slice(0, 500).map((flag) => ({
      speaker: flag.speaker.slice(0, 256),
      sourceText: flag.sourceText.slice(0, 4000),
      chunkIndex: flag.chunkIndex,
      attempts: flag.attempts,
      reason: flag.reason.slice(0, 256),
    })),
  };
  await putAudiobookObject(input.bookId, input.userId, fileName,
    Buffer.from(JSON.stringify(body, null, 2)), 'application/json; charset=utf-8', input.namespace ?? null);
}
