import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { adminSettings, documents } from '@/db/schema';
import type { SourceRecoveryAnalysis, SourceRecoveryOccurrence } from '@/types/source-recovery';
import { FOREIGN_WORD_CANDIDATE_CACHE_VERSION } from './gemini-foreign-word-scan';

export class SourceRecoveryConflict extends Error {}
export async function requireOwnedPdf(userId: string, documentId: string) {
  const [document] = await db.select({ type: documents.type }).from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.userId, userId))).limit(1);
  if (!document || document.type !== 'pdf') throw new Error('PDF not found');
}
function key(userId: string, documentId: string) {
  return `source_recovery:v1:${createHash('sha256').update(userId).digest('hex')}:${documentId}`;
}
function encoded(value: SourceRecoveryAnalysis) {
  return (process.env.POSTGRES_URL ? value : JSON.stringify(value)) as never;
}
export async function readSourceRecovery(userId: string, documentId: string): Promise<SourceRecoveryAnalysis | null> {
  const [row] = await db.select({ value: adminSettings.valueJson }).from(adminSettings)
    .where(eq(adminSettings.key, key(userId, documentId))).limit(1);
  const value = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value;
  return value?.schemaVersion === 1 && value.documentId === documentId ? value : null;
}
export async function saveSourceRecovery(userId: string, analysis: SourceRecoveryAnalysis, expectedRevision: number) {
  if (analysis.revision !== expectedRevision + 1) throw new SourceRecoveryConflict('Invalid analysis revision');
  const revision = process.env.POSTGRES_URL
    ? sql`(${adminSettings.valueJson}->>'revision')::int = ${expectedRevision}`
    : sql`json_extract(${adminSettings.valueJson}, '$.revision') = ${expectedRevision}`;
  const rows = await db.update(adminSettings).set({ valueJson: encoded(analysis), updatedAt: Date.now() })
    .where(and(eq(adminSettings.key, key(userId, analysis.documentId)), revision)).returning({ key: adminSettings.key });
  if (!rows.length) throw new SourceRecoveryConflict('PDF analysis changed. Refresh before reviewing again.');
}

type ScanRow = { word: string; sourceStatus?: string; sourceOutcome?: string; sourceRepairReasons?: string[];
  qualityFlags?: string[]; ocrSuspect?: boolean; ocrFragment?: boolean; fuzzyGroupVariants?: string[];
  occurrences?: { surfaceTerm: string; pdfPage: number; pageSourceStart: number; context: string;
    contextTargetStart: number; contextTargetEnd: number; qualityFlags?: string[] }[] };

export function recoveryOccurrences(rows: ScanRow[]): SourceRecoveryOccurrence[] {
  const result = new Map<string, SourceRecoveryOccurrence>();
  for (const row of rows) {
    const reasons = [...(row.sourceRepairReasons || []), ...(row.qualityFlags || [])];
    if (row.sourceStatus === 'needs_source_repair' || row.sourceOutcome === 'needs_source_repair') {
      reasons.push('Source reading is unresolved; verify against the PDF.');
    }
    if (row.ocrSuspect || row.ocrFragment) reasons.push('Scanner detected possible OCR damage.');
    if (!reasons.length) continue;
    const variants = [...new Set([row.word, ...(row.fuzzyGroupVariants || [])])].sort();
    const groupId = createHash('sha256').update(JSON.stringify(variants)).digest('hex').slice(0, 24);
    for (const occurrence of row.occurrences || []) {
      if (!Number.isInteger(occurrence.pdfPage) || occurrence.pdfPage < 1 || !occurrence.surfaceTerm) continue;
      const chars = Array.from(occurrence.context);
      if (chars.slice(occurrence.contextTargetStart, occurrence.contextTargetEnd).join('') !== occurrence.surfaceTerm) continue;
      const id = createHash('sha256').update(JSON.stringify([
        occurrence.pdfPage, occurrence.pageSourceStart, occurrence.surfaceTerm,
      ])).digest('hex').slice(0, 32);
      result.set(id, { id, groupId, surface: occurrence.surfaceTerm, pdfPage: occurrence.pdfPage,
        pageSourceStart: occurrence.pageSourceStart,
        before: chars.slice(Math.max(0, occurrence.contextTargetStart - 48), occurrence.contextTargetStart).join(''),
        after: chars.slice(occurrence.contextTargetEnd, occurrence.contextTargetEnd + 48).join(''),
        context: occurrence.context, reasons: [...new Set([...reasons, ...(occurrence.qualityFlags || [])])], status: 'unresolved' });
    }
  }
  return [...result.values()];
}
export async function registerSourceRecovery(userId: string, documentId: string, rows: ScanRow[]) {
  await requireOwnedPdf(userId, documentId);
  const initial: SourceRecoveryAnalysis = { schemaVersion: 1, documentId, revision: 0,
    extractionVersion: FOREIGN_WORD_CANDIDATE_CACHE_VERSION, scannedAt: Date.now(), occurrences: [], diagnostics: [] };
  await db.insert(adminSettings).values({ key: key(userId, documentId), valueJson: encoded(initial), source: 'runtime' })
    .onConflictDoNothing();
  const current = (await readSourceRecovery(userId, documentId))!;
  const indexed = recoveryOccurrences(rows);
  const previous = new Map(current.occurrences.map((item) => [item.id, item]));
  const occurrences = indexed.map((item) => {
    const old = previous.get(item.id);
    return old && old.before === item.before && old.after === item.after && current.extractionVersion === FOREIGN_WORD_CANDIDATE_CACHE_VERSION
      ? { ...item, status: old.status, proposal: old.proposal, reviewedAt: old.reviewedAt, analyzedAt: old.analyzedAt } : item;
  });
  // Partial/custom scans must not delete evidence discovered in a full scan.
  const indexedIds = new Set(indexed.map((item) => item.id));
  for (const old of current.occurrences) {
    if (indexedIds.has(old.id)) continue;
    occurrences.push(current.extractionVersion === FOREIGN_WORD_CANDIDATE_CACHE_VERSION ? old : {
      ...old, status: 'unresolved', proposal: undefined, reviewedAt: undefined, analyzedAt: undefined,
      reasons: [...old.reasons, 'Extraction version changed; review this reading again.'],
    });
  }
  const analysis = { ...current, revision: current.revision + 1, scannedAt: Date.now(),
    extractionVersion: FOREIGN_WORD_CANDIDATE_CACHE_VERSION, occurrences };
  await saveSourceRecovery(userId, analysis, current.revision);
  return analysis;
}

export async function deleteSourceRecovery(userId: string, documentId: string): Promise<void> {
  await db.delete(adminSettings).where(eq(adminSettings.key, key(userId, documentId)));
}
