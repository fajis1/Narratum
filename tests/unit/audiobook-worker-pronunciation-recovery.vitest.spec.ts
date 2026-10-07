import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as schema from '@/db/schema_sqlite';

const mocks = vi.hoisted(() => ({ database: undefined as unknown as ReturnType<typeof drizzle>, propose: vi.fn() }));
vi.mock('@/db', () => ({ get db() { return mocks.database; } }));
vi.mock('@/db/schema', async () => import('../../src/db/schema_sqlite'));
vi.mock('@/lib/server/audiobooks/system-monitor', () => ({ checkSystemResources: async () => ({ ok: true }) }));
vi.mock('@/lib/server/audiobooks/pronunciation-repairs', () => ({
  proposePronunciationRepair: (...args: unknown[]) => mocks.propose(...args),
  assertPronunciationBookIdle: vi.fn(), existingPronunciationRepair: vi.fn(),
}));
// Exercise the real worker dispatch and real repair finalization. No Gemini,
// recording, blobstore or production database operations are needed.
import { processAudiobookQueue } from '@/lib/server/audiobooks/worker';

let sqlite: Database.Database;
const workerState = globalThis as typeof globalThis & { __worker_booted?: boolean };
let previousBootState: boolean | undefined;
const chapters = [{ fileName: '0001__text.txt', hash: 'a'.repeat(64) }, { fileName: '0002__text.txt', hash: 'b'.repeat(64) }];
const results = [
  { fileName: chapters[0].fileName, runId: 'saved', requestId: 'one' },
  { fileName: chapters[1].fileName, error: 'Validation failed', requestId: 'two' },
];

beforeEach(() => {
  vi.clearAllMocks();
  previousBootState = workerState.__worker_booted;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE audiobook_jobs (
      id text PRIMARY KEY, user_id text NOT NULL, document_id text NOT NULL,
      status text NOT NULL, progress real, settings_json text NOT NULL,
      created_at integer, updated_at integer, started_at integer,
      completed_at integer, error text
    );
    CREATE TABLE documents (
      id text, user_id text, name text, type text, size integer,
      last_modified integer, file_path text, created_at integer
    );
  `);
  mocks.database = drizzle(sqlite);
  mocks.database.insert(schema.documents).values({ id: 'book', userId: 'owner', name: 'Scholarly book', type: 'pdf', size: 1, lastModified: 1, filePath: 'fixture' }).run();
  mocks.database.insert(schema.audiobookJobs).values({
    id: 'repair', userId: 'owner', documentId: 'book', status: 'running',
    progress: 100, completedAt: null, createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 20 * 60000,
    settingsJson: { jobType: 'pronunciation-repair', chapters, results },
  }).run();
});
afterEach(() => {
  sqlite.close();
  workerState.__worker_booted = previousBootState;
  vi.clearAllTimers();
  vi.useRealTimers();
});

test.each(['process restart', 'stale heartbeat'])('outer worker reclaims and finalizes a 100%% repair checkpoint after %s', async scenario => {
  workerState.__worker_booted = scenario === 'stale heartbeat';
  if (scenario === 'stale heartbeat') {
    mocks.database.insert(schema.audiobookJobs).values({ id: 'fresh', userId: 'owner', documentId: 'book', status: 'running', progress: 12, settingsJson: {}, updatedAt: Date.now() }).run();
  }
  await processAudiobookQueue();
  const recovered = mocks.database.select().from(schema.audiobookJobs).where(eq(schema.audiobookJobs.id, 'repair')).get()!;
  expect(recovered).toMatchObject({ status: 'error', progress: 100, completedAt: expect.any(Number), error: '1 chapter repairs failed; review individual errors and retry those chapters.' });
  const settings = typeof recovered.settingsJson === 'string' ? JSON.parse(recovered.settingsJson) : recovered.settingsJson;
  expect(settings.results).toEqual(results);
  expect(settings.chapters).toEqual(chapters);
  expect(settings).not.toHaveProperty('nextAttemptAt');
  expect(mocks.propose).not.toHaveBeenCalled();
  if (scenario === 'stale heartbeat') {
    expect(mocks.database.select().from(schema.audiobookJobs).where(eq(schema.audiobookJobs.id, 'fresh')).get()).toMatchObject({ status: 'running', progress: 12 });
  }
});
