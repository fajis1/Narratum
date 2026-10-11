import { batchRefineTextHash } from './batch-refine-assessment';
import { getAudiobookObjectBuffer, isMissingBlobError, listAudiobookObjects, type AudiobookBlobObject } from './blobstore';

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Retained diagnostics are history only when a later authoritative recording proves recovery. */
export async function readActiveChapterReviewIndexes(
  bookId: string, userId: string, namespace: string | null, names: string[], recorded: number[],
  inventory?: Pick<AudiobookBlobObject, 'fileName' | 'lastModified'>[],
): Promise<number[]> {
  const diagnostics = names.filter(name => /^\d{1,6}__(?:pronunciation_failure\.json|rejected\.txt)$/u.test(name));
  if (!diagnostics.length) return [];
  const objects = diagnostics.some(name => name.endsWith('__rejected.txt'))
    ? inventory ?? await listAudiobookObjects(bookId, userId, namespace) : [];
  const readJson = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      const value = JSON.parse((await getAudiobookObjectBuffer(bookId, userId, name, namespace)).toString('utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (error) {
      if (isMissingBlobError(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  };
  const active = new Set<number>();
  for (const name of diagnostics) {
    const index = Number(name.split('__')[0]) - 1;
    if (!recorded.includes(index)) { active.add(index); continue; }
    const prefix = name.split('__')[0];
    const receipt = await readJson(`${prefix}__recording_state.json`);
    if (!validTimestamp(receipt?.recordedAt)) { active.add(index); continue; }
    const failureName = `${prefix}__pronunciation_failure.json`;
    const failure = names.includes(failureName) ? await readJson(failureName) : null;
    if (names.includes(failureName) && (!validTimestamp(failure?.createdAt) || receipt.recordedAt < failure.createdAt)) {
      active.add(index); continue;
    }
    if (name.endsWith('__rejected.txt')) {
      const modified = objects.find(object => object.fileName === name)?.lastModified;
      // S3 modification times can be rounded to whole seconds. Require a
      // clear ordering when failure metadata is missing or doesn't match.
      const timestampProvesRecovery = validTimestamp(modified) && receipt.recordedAt > modified + 999;
      const rejected = await getAudiobookObjectBuffer(bookId, userId, name, namespace);
      const metadataProvesRecovery = failure && validTimestamp(failure.createdAt)
        && receipt.recordedAt >= failure.createdAt
        && failure.rejectedHash === batchRefineTextHash(rejected.toString('utf8'))
        && (!validTimestamp(modified) || receipt.recordedAt > modified + 999);
      if (!timestampProvesRecovery && !metadataProvesRecovery) active.add(index);
    }
  }
  return [...active].sort((a, b) => a - b);
}
