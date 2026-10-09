import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { adminSettings } from '@/db/schema';
import { classifyForeignWordSourceIntegrity, requiresForeignWordSourceRepair } from '@/lib/shared/foreign-word-source-integrity';

/** Scan actions consult saved evidence, never client-supplied source statuses.
 * Standalone explicit dictionary-management actions have no scan context.
 */
export async function scanPronunciationActionError(userId: string | null, context: unknown, word: unknown,
  promote = false): Promise<string | null> {
  if (context === undefined) return null;
  if (!userId || !context || typeof context !== 'object' || typeof word !== 'string') return 'Invalid scan action.';
  const { jobId, documentId } = context as { jobId?: unknown; documentId?: unknown };
  if (typeof jobId !== 'string' || !jobId || typeof documentId !== 'string' || !documentId) return 'Invalid scan action.';
  const [stored] = await db.select({ value: adminSettings.valueJson }).from(adminSettings)
    .where(eq(adminSettings.key, `foreign_word_scan:${jobId}`)).limit(1);
  const job = typeof stored?.value === 'string' ? JSON.parse(stored.value) : stored?.value;
  if (!job || job.userId !== userId || job.documentId !== documentId || !Array.isArray(job.words)) return 'Scan not found for this document.';
  const saved = job.words.find((row: { word?: unknown }) => row.word === word);
  if (!saved) return 'Word not found in this scan.';
  const row = classifyForeignWordSourceIntegrity(saved);
  if (requiresForeignWordSourceRepair(row)) return 'Verify the printed PDF source before generating or saving a pronunciation.';
  if (promote && (row.sourceStatus === 'verified_document_reading'
      || Number(row.sourceRecoveryCounts?.applied || 0) > 0 || row.sourceOutcome === 'insufficient_context')) return 'This scan reading requires document-local review; use the document pronunciation import.';
  return null;
}
