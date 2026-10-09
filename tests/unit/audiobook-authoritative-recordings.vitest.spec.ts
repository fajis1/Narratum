import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import * as schema from '@/db/schema_sqlite';

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as ReturnType<typeof drizzle>,
  blobs: new Map<string, Buffer>(),
  reads: [] as string[],
  uploaded: new Map<string, Buffer>(),
}));
vi.mock('@/db', () => ({ get db() { return mocks.db; } }));
vi.mock('@/db/schema', async () => import('../../src/db/schema_sqlite'));
vi.mock('@/lib/server/logger', () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, errorToLog: vi.fn() }));
vi.mock('@/lib/server/audiobooks/ffmpeg-bin', () => ({ getFFmpegPath: () => '/mock/ffmpeg' }));
vi.mock('child_process', () => ({
  spawn: () => {
    const listeners: Record<string, (value?: number) => void> = {};
    return {
      stderr: { on: vi.fn() },
      on: (event: string, callback: (value?: number) => void) => {
        listeners[event] = callback;
        if (event === 'close') queueMicrotask(() => callback(0));
        return this;
      },
      kill: vi.fn(),
    };
  },
}));
vi.mock('fs', () => ({ createReadStream: () => ({ async *[Symbol.asyncIterator]() { yield Buffer.from('combined-book'); } }) }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  listAudiobookObjects: async () => [...mocks.blobs].map(([fileName, body]) => ({ fileName, size: body.length })),
  getAudiobookObjectBuffer: async (_book: string, _user: string, fileName: string) => {
    mocks.reads.push(fileName);
    const value = mocks.blobs.get(fileName);
    if (!value) throw Object.assign(new Error('Not found'), { code: 'NoSuchKey' });
    return value;
  },
  isMissingBlobError: (error: { code?: string }) => error.code === 'NoSuchKey',
  putAudiobookObject: async (_book: string, _user: string, fileName: string, body: Buffer | AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    mocks.blobs.set(fileName, buffer);
    mocks.uploaded.set(fileName, buffer);
  },
}));
vi.mock('@/lib/server/audiobooks/chapters', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/audiobooks/chapters')>('@/lib/server/audiobooks/chapters');
  return { ...actual, ffprobeAudio: async () => ({ durationSec: 1 }) };
});

import { resolveChapterRecordings, listChapterObjects } from '@/lib/server/audiobooks/chapters';
import { executeAudiobookCombine } from '@/lib/server/audiobooks/combine';
import { persistAudiobookChapter } from '@/lib/server/audiobooks/chapter-record';

let sqlite: Database.Database;
beforeEach(() => {
  mocks.blobs.clear(); mocks.reads.length = 0; mocks.uploaded.clear();
  sqlite = new Database(':memory:');
  for (const table of [schema.audiobooks, schema.audiobookJobs, schema.audiobookChapters]) {
    const config = getTableConfig(table);
    sqlite.exec(`CREATE TABLE "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}`).join(', ')}${config.name === 'audiobook_chapters' ? ', UNIQUE(id, user_id)' : ''})`);
  }
  mocks.db = drizzle(sqlite);
  mocks.db.insert(schema.audiobooks).values({ id: 'book', userId: 'owner', title: 'Book' }).run();
  mocks.db.insert(schema.audiobookJobs).values({ id: 'job', userId: 'owner', documentId: 'book', status: 'completed', settingsJson: { expectedChapterIndexes: [0, 25, 26] }, createdAt: 1, updatedAt: 2 }).run();
  mocks.db.insert(schema.audiobookChapters).values([
    { id: 'row-0', bookId: 'book', userId: 'owner', chapterIndex: 0, title: 'One', filePath: '0001__One.mp3', format: 'mp3' },
    { id: 'row-25', bookId: 'book', userId: 'owner', chapterIndex: 25, title: 'Chapter 26', filePath: '0026__Chapter 26.mp3', format: 'mp3' },
    { id: 'row-26', bookId: 'book', userId: 'owner', chapterIndex: 26, title: 'Last', filePath: '0027__Last.mp3', format: 'mp3' },
  ]).run();
  for (const name of ['0001__One.mp3', '0026__Chapter 26.mp3', '0026__Imperial.mp3', '0027__Last.mp3']) mocks.blobs.set(name, Buffer.from(name));
});
afterEach(() => sqlite.close());

test('inventory retains duplicate names while authority resolution selects the database path in chapter order', () => {
  const names = [...mocks.blobs.keys()];
  const rows = mocks.db.select({ chapterIndex: schema.audiobookChapters.chapterIndex, title: schema.audiobookChapters.title,
    filePath: schema.audiobookChapters.filePath, format: schema.audiobookChapters.format }).from(schema.audiobookChapters).all();
  expect(listChapterObjects(names).filter(chapter => chapter.index === 25).map(chapter => chapter.fileName))
    .toEqual(['0026__Chapter 26.mp3', '0026__Imperial.mp3']);
  const resolution = resolveChapterRecordings(names, rows, [0, 25, 26]);
  expect(resolution.issues).toEqual([]);
  expect(resolution.chapters.map(chapter => [chapter.index, chapter.fileName])).toEqual([
    [0, '0001__One.mp3'], [25, '0026__Chapter 26.mp3'], [26, '0027__Last.mp3'],
  ]);
});

test('full audiobook compilation reads the authoritative file exactly once and ignores stale duplicate audio', async () => {
  await executeAudiobookCombine('book', 'owner', 'mp3', null);
  expect(mocks.reads.filter(name => name.endsWith('.mp3'))).toEqual(['0001__One.mp3', '0026__Chapter 26.mp3', '0027__Last.mp3']);
  expect(mocks.reads).not.toContain('0026__Imperial.mp3');
  expect(JSON.parse(mocks.blobs.get('complete.mp3.manifest.json')!.toString()).map((item: { index: number }) => item.index)).toEqual([0, 25, 26]);
});

test('missing authoritative recording blocks compilation despite another file for its chapter index', async () => {
  mocks.blobs.delete('0026__Chapter 26.mp3');
  await expect(executeAudiobookCombine('book', 'owner', 'mp3', null)).rejects.toThrow(/chapter 26/i);
  expect(mocks.reads.filter(name => name.endsWith('.mp3'))).toEqual([]);
  expect(mocks.blobs.get('0026__Imperial.mp3')?.toString()).toBe('0026__Imperial.mp3');
});

test('replacement recordings update the DB authority and the same compiler resolution selects the replacement', async () => {
  await persistAudiobookChapter({ bookId: 'book', userId: 'owner', chapterIndex: 25, title: 'Recovered', filePath: '0026__Recovered.mp3', format: 'mp3' });
  mocks.blobs.set('0026__Recovered.mp3', Buffer.from('recovered audio'));
  const row = mocks.db.select().from(schema.audiobookChapters).where(eq(schema.audiobookChapters.chapterIndex, 25)).get();
  expect(row?.id).toBe('row-25');
  expect(row?.filePath).toBe('0026__Recovered.mp3');
  await executeAudiobookCombine('book', 'owner', 'mp3', null);
  expect(mocks.reads).toContain('0026__Recovered.mp3');
  expect(mocks.reads).not.toContain('0026__Chapter 26.mp3');
  expect(mocks.reads).not.toContain('0026__Imperial.mp3');
});

test('a single-file chapter book continues to resolve and compile normally', async () => {
  mocks.db.update(schema.audiobookJobs).set({ settingsJson: { expectedChapterIndexes: [0] } }).where(eq(schema.audiobookJobs.id, 'job')).run();
  await executeAudiobookCombine('book', 'owner', 'mp3', null);
  expect(mocks.reads.filter(name => name.endsWith('.mp3'))).toEqual(['0001__One.mp3']);
});
