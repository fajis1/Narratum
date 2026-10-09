import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ database: undefined as unknown as ReturnType<typeof drizzle> }));
vi.mock('@/db', () => ({ get db() { return mocks.database; } }));
vi.mock('@/db/schema', async () => import('../../src/db/schema_sqlite'));
import { deleteSourceRecovery, readSourceRecovery, registerSourceRecovery, requireOwnedPdf, saveSourceRecovery } from '@/lib/server/smart-audio/source-recovery-store';
let sqlite: Database.Database;
let previousPostgres: string | undefined;
const rows = [{ word: 'xatagyéw', sourceOutcome: 'needs_source_repair', occurrences: [{
  surfaceTerm: 'xatagyéw', pdfPage: 1, pageSourceStart: 9, context: 'The word xatagyéw means abolish.', contextTargetStart: 9, contextTargetEnd: 17,
}] }];
beforeEach(() => {
  previousPostgres = process.env.POSTGRES_URL; delete process.env.POSTGRES_URL;
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE documents (id text, user_id text, type text); CREATE TABLE admin_settings (key text PRIMARY KEY, value_json text NOT NULL, source text DEFAULT 'admin', updated_at integer DEFAULT 1);`);
  sqlite.prepare('INSERT INTO documents VALUES (?, ?, ?)').run('pdf', 'owner', 'pdf');
  sqlite.prepare('INSERT INTO documents VALUES (?, ?, ?)').run('pdf', 'other-owner', 'pdf');
  mocks.database = drizzle(sqlite);
});
afterEach(() => { sqlite.close(); if (previousPostgres === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = previousPostgres; });
test('enforces ownership and isolates analysis for two owners of the same PDF', async () => {
  await expect(requireOwnedPdf('stranger', 'pdf')).rejects.toThrow('PDF not found');
  await registerSourceRecovery('owner', 'pdf', rows);
  expect(await readSourceRecovery('other-owner', 'pdf')).toBeNull();
  await registerSourceRecovery('other-owner', 'pdf', rows);
  const first = await readSourceRecovery('owner', 'pdf');
  expect(first?.occurrences).toHaveLength(1);
  expect(sqlite.prepare('SELECT count(*) AS count FROM admin_settings').get()).toEqual({ count: 2 });
});
test('rejects concurrent stale saves using the database revision', async () => {
  const current = await registerSourceRecovery('owner', 'pdf', rows);
  const next = { ...current, revision: current.revision + 1 };
  await saveSourceRecovery('owner', next, current.revision);
  await expect(saveSourceRecovery('owner', next, current.revision)).rejects.toThrow('analysis changed');
  expect((await readSourceRecovery('owner', 'pdf'))?.revision).toBe(next.revision);
});
test('retains exact reviewed decisions across rescans but resets changed context anchors', async () => {
  const current = await registerSourceRecovery('owner', 'pdf', rows);
  current.occurrences[0].status = 'rejected'; current.revision++;
  await saveSourceRecovery('owner', current, current.revision - 1);
  const same = await registerSourceRecovery('owner', 'pdf', rows);
  expect(same.occurrences[0].status).toBe('rejected');
  const changed = await registerSourceRecovery('owner', 'pdf', [{ ...rows[0], occurrences: [{ ...rows[0].occurrences[0], context: 'The word xatagyéw means something else.' }] }]);
  expect(changed.occurrences[0].status).toBe('unresolved');
  expect(changed.occurrences[0].reasons).toContain('Source reading is unresolved; verify against the PDF.');
});
test('uses codepoint offsets for contexts containing supplementary Unicode characters', async () => {
  const context = '😀 word xatagyéw means';
  const next = await registerSourceRecovery('owner', 'pdf', [{ ...rows[0], occurrences: [{ ...rows[0].occurrences[0], context, contextTargetStart: 7, contextTargetEnd: 15 }] }]);
  expect(next.occurrences[0].before).toBe('😀 word ');
});

test('invalidates old extraction-version approvals even when a partial rescan omits their rows', async () => {
  const current = await registerSourceRecovery('owner', 'pdf', rows);
  current.extractionVersion = 12; current.occurrences[0].status = 'approved'; current.revision++;
  await saveSourceRecovery('owner', current, current.revision - 1);
  const refreshed = await registerSourceRecovery('owner', 'pdf', []);
  expect(refreshed.occurrences[0].status).toBe('unresolved');
  expect(refreshed.occurrences[0].reasons).toContain('Extraction version changed; review this reading again.');
});


test('deletes only the specified owner’s document analysis', async () => {
  await registerSourceRecovery('owner', 'pdf', rows);
  await registerSourceRecovery('other-owner', 'pdf', rows);
  await deleteSourceRecovery('owner', 'pdf');
  expect(await readSourceRecovery('owner', 'pdf')).toBeNull();
  expect(await readSourceRecovery('other-owner', 'pdf')).not.toBeNull();
});
