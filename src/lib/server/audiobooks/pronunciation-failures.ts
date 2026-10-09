import { putAudiobookObject, listAudiobookObjects, getAudiobookObjectBuffer } from './blobstore';
import { batchRefineTextHash } from './batch-refine-assessment';
import { resolveMultiVoiceWorkerResult, renderVoiceSegments, type MultiVoiceCastMember } from '@/lib/shared/multi-voice';

export async function savePronunciationFailure(input: {
  bookId: string; userId: string; chapterIndex: number; chapterTitle: string;
  sourceText: string; rejected: Record<string, unknown>; errors: string[];
  jobId?: string; profileId?: string; cast?: MultiVoiceCastMember[]; namespace?: string | null;
}): Promise<void> {
  let text = typeof input.rejected.cleaned_text === 'string' ? input.rejected.cleaned_text : '';
  if (Array.isArray(input.rejected.segments)) {
    // Resolve voices one segment at a time using placeholder text, so invalid
    // IPA cannot prevent retaining the actual rejected text for human repair.
    const segments = input.rejected.segments.flatMap(raw => {
      if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || /[<>]/u.test(raw.text)) throw new Error('Cannot retain invalid speaker structure for pronunciation-only repair.');
      const resolved = resolveMultiVoiceWorkerResult({ status: 'success', segments: [{ ...raw, text: 'Review.' }] }, input.cast || []);
      return resolved.segments.map(segment => ({ ...segment, text: raw.text as string }));
    });
    text = renderVoiceSegments(segments);
  }
  if (!text || text.length > 500000) return;
  const prefix = String(input.chapterIndex + 1).padStart(4, '0');
  const namespace = input.namespace ?? null;
  const objects = await listAudiobookObjects(input.bookId, input.userId, namespace);
  const canonicalName = `${prefix}__text.txt`;
  const canonicalHash = objects.some(object => object.fileName === canonicalName)
    ? batchRefineTextHash((await getAudiobookObjectBuffer(input.bookId, input.userId, canonicalName, namespace)).toString('utf8')) : null;
  await putAudiobookObject(input.bookId, input.userId, `${prefix}__rejected.txt`, Buffer.from(text), 'text/plain; charset=utf-8', namespace);
  await putAudiobookObject(input.bookId, input.userId, `${prefix}__pronunciation_failure.json`, Buffer.from(JSON.stringify({
    chapterIndex: input.chapterIndex, chapterTitle: input.chapterTitle, sourceText: input.sourceText,
    jobId: input.jobId, profileId: input.profileId, canonicalHash, rejectedHash: batchRefineTextHash(text),
    failureCategory: 'content_validation',
    errors: input.errors.map(error => error.slice(0, 1500)), createdAt: Date.now(),
  })), 'application/json; charset=utf-8', namespace);
}
