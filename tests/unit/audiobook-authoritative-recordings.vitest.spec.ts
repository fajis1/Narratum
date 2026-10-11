import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import * as schema from '@/db/schema_sqlite';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  db: undefined as unknown as ReturnType<typeof drizzle>,
  blobs: new Map<string, Buffer>(),
  reads: [] as string[],
  uploaded: new Map<string, Buffer>(),
  userId: 'owner',
}));
vi.mock('@/db', () => ({ get db() { return mocks.db; } }));
vi.mock('@/db/schema', async () => import('../../src/db/schema_sqlite'));
vi.mock('@/lib/server/logger', () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, errorToLog: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: async () => ({ userId: mocks.userId }) }));
vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true }));
vi.mock('@/lib/server/admin/settings', () => ({ getRuntimeConfig: async () => ({
  audiobookshelfUrl: 'http://shelf.test', audiobookshelfToken: 'fixture', audiobookshelfLibraryId: 'library', audiobookshelfFolderId: 'folder',
}) }));
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
import { readAudiobookCompleteness } from '@/lib/server/audiobooks/completeness';
import { EMPTY_FINAL_CHAPTER_RECEIPT } from '@/lib/server/audiobooks/empty-final-chapter';
import { POST as omitFinal } from '@/app/api/audiobook/omit-empty-final-chapter/route';
import { GET as status } from '@/app/api/audiobook/status/route';
import { uploadBookToAudiobookshelf } from '@/lib/server/audiobooks/audiobookshelf';

let sqlite: Database.Database;
beforeEach(() => {
  mocks.blobs.clear(); mocks.reads.length = 0; mocks.uploaded.clear();
  mocks.userId = 'owner';
  sqlite = new Database(':memory:');
  for (const table of [schema.audiobooks, schema.audiobookJobs, schema.audiobookChapters, schema.documents]) {
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
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); });

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

function addEmptyFinalChapter() {
  mocks.db.update(schema.audiobookJobs).set({ settingsJson: { expectedChapterIndexes: [0, 25, 26, 73] } }).where(eq(schema.audiobookJobs.id, 'job')).run();
}
const omissionRequest = (snapshotHash: string, extra: Record<string, unknown> = {}) => new NextRequest('http://localhost/api/audiobook/omit-empty-final-chapter', {
  method: 'POST', body: JSON.stringify({ bookId: 'book', chapterIndex: 73, snapshotHash, confirmOmit: true, ...extra }),
});

test('explicitly omitting a missing final placeholder restores compilation and hides chapter 74 without changing audio or required mappings', async () => {
  addEmptyFinalChapter();
  const before = await readAudiobookCompleteness('book', 'owner', null);
  expect(before.complete).toBe(false);
  expect(before.missingChapterIndexes).toEqual([73]);
  const candidate = before.emptyFinalChapterOmissionCandidate!;
  const beforeStatus = await status(new NextRequest('http://localhost/api/audiobook/status?bookId=book'));
  expect((await beforeStatus.json()).chapters.find((c: { index: number }) => c.index === 73))
    .toMatchObject({ hasAudio: false, emptyFinalChapterSnapshot: candidate.snapshotHash });
  const recordings = mocks.db.select().from(schema.audiobookChapters).all();
  const settings = mocks.db.select().from(schema.audiobookJobs).all();
  expect((await omitFinal(omissionRequest(candidate.snapshotHash, { confirmOmit: false }))).status).toBe(400);
  expect(mocks.blobs.has(EMPTY_FINAL_CHAPTER_RECEIPT)).toBe(false);
  expect((await omitFinal(omissionRequest(candidate.snapshotHash))).status).toBe(200);
  expect(await readAudiobookCompleteness('book', 'owner', null)).toMatchObject({
    complete: true, missingChapterIndexes: [], omittedChapterIndexes: [73], emptyFinalChapterOmissionCandidate: null,
  });
  expect(mocks.db.select().from(schema.audiobookChapters).all()).toEqual(recordings);
  expect(mocks.db.select().from(schema.audiobookJobs).all()).toEqual(settings);
  await executeAudiobookCombine('book', 'owner', 'mp3', null);
  expect(JSON.parse(mocks.blobs.get('complete.mp3.manifest.json')!.toString()).map((c: { index: number }) => c.index)).toEqual([0, 25, 26]);
  const after = await status(new NextRequest('http://localhost/api/audiobook/status?bookId=book'));
  expect((await after.json()).chapters.map((c: { index: number }) => c.index)).toEqual([0, 25, 26]);
});

test('an empty text artifact does not bring an approved placeholder back; restored text invalidates its receipt', async () => {
  addEmptyFinalChapter();
  mocks.blobs.set('0074__original.txt', Buffer.from(' \n'));
  const candidate = (await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate!;
  expect((await omitFinal(omissionRequest(candidate.snapshotHash))).status).toBe(200);
  const after = await status(new NextRequest('http://localhost/api/audiobook/status?bookId=book'));
  expect((await after.json()).chapters.some((c: { index: number }) => c.index === 73)).toBe(false);
  mocks.blobs.set('0074__original.txt', Buffer.from('This is actual content.'));
  expect(await readAudiobookCompleteness('book', 'owner', null)).toMatchObject({ complete: false, missingChapterIndexes: [73] });
  await expect(executeAudiobookCombine('book', 'owner', 'mp3', null)).rejects.toThrow(/incomplete audiobook/i);
});

test.each(['original.txt', 'text.txt', 'rejected.txt', 'pronunciation_failure.json', 'audio.mp3'])('retained %s content prevents omitting the last chapter', async suffix => {
  addEmptyFinalChapter();
  mocks.blobs.set(`0074__${suffix}`, Buffer.from('Retained content'));
  expect((await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate).toBeNull();
  expect((await omitFinal(omissionRequest('a'.repeat(64)))).status).toBe(409);
});

test('missing per-chapter files do not permit omitting non-empty pinned source or an existing chapter record', async () => {
  addEmptyFinalChapter();
  mocks.blobs.set('audiobook.source-chapters.json', Buffer.from(JSON.stringify({ schemaVersion: 1, chapters: [{ index: 73, text: 'Narrative original source.' }] })));
  expect((await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate).toBeNull();
  mocks.blobs.delete('audiobook.source-chapters.json');
  mocks.db.insert(schema.audiobookChapters).values({ id: 'row-73', bookId: 'book', userId: 'owner', chapterIndex: 73, title: 'Lost recording', filePath: '0074__Lost.mp3', format: 'mp3' }).run();
  expect((await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate).toBeNull();
});

test('active generation, another owner, stale snapshots and a different chapter cannot authorize omission', async () => {
  addEmptyFinalChapter();
  const hash = (await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate!.snapshotHash;
  expect((await omitFinal(omissionRequest(hash, { chapterIndex: 25 }))).status).toBe(409);
  expect((await omitFinal(omissionRequest('a'.repeat(64)))).status).toBe(409);
  mocks.db.update(schema.audiobookJobs).set({ status: 'running' }).run();
  expect((await omitFinal(omissionRequest(hash))).status).toBe(409);
  mocks.userId = 'another-owner';
  expect((await omitFinal(omissionRequest(hash))).status).toBe(404);
  mocks.userId = '';
  expect((await omitFinal(omissionRequest(hash))).status).toBe(401);
  expect(mocks.blobs.has(EMPTY_FINAL_CHAPTER_RECEIPT)).toBe(false);
});

test('a new generation mapping invalidates an old manual omission and earlier missing chapters remain required', async () => {
  addEmptyFinalChapter();
  const hash = (await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate!.snapshotHash;
  expect((await omitFinal(omissionRequest(hash))).status).toBe(200);
  mocks.db.insert(schema.audiobookJobs).values({ id: 'new-job', documentId: 'book', userId: 'owner', status: 'completed', settingsJson: { expectedChapterIndexes: [0, 25, 26, 73] }, createdAt: 5, updatedAt: 6 }).run();
  expect(await readAudiobookCompleteness('book', 'owner', null)).toMatchObject({ complete: false, missingChapterIndexes: [73] });
  mocks.blobs.delete('0026__Chapter 26.mp3');
  const current = await readAudiobookCompleteness('book', 'owner', null);
  expect(current.missingChapterIndexes).toEqual([25, 73]);
  expect(current.emptyFinalChapterOmissionCandidate).toBeNull();
});

test('a later artifact or alternate chapter prefix prevents mistaking the final required slot for an empty ending', async () => {
  addEmptyFinalChapter();
  for (const name of ['0075__original.txt', '74__original.txt']) {
    mocks.blobs.set(name, Buffer.from('Retained source'));
    expect((await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate).toBeNull();
    mocks.blobs.delete(name);
  }
});

test('full Audiobookshelf upload rejects chapter 74 before confirmation and uploads the remaining compiled audio afterward', async () => {
  addEmptyFinalChapter();
  const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true })));
  vi.stubGlobal('fetch', request);
  const options = { bookId: 'book', userId: 'owner', title: 'Book', smartMatchExistingBook: false, includeCompanionDocument: false };
  await expect(uploadBookToAudiobookshelf(options)).rejects.toThrow('missing chapter(s): 74');
  expect(request).not.toHaveBeenCalled();
  const candidate = (await readAudiobookCompleteness('book', 'owner', null)).emptyFinalChapterOmissionCandidate!;
  expect((await omitFinal(omissionRequest(candidate.snapshotHash))).status).toBe(200);
  expect(await uploadBookToAudiobookshelf(options)).toMatchObject({ success: true, files: ['Book.mp3'] });
  const upload = request.mock.calls.find(call => call[0] === 'http://shelf.test/api/upload');
  expect(upload).toBeDefined();
  const audio = (upload![1].body as FormData).get('file') as File;
  expect(await audio.text()).toBe('combined-book');
  expect(JSON.parse(mocks.blobs.get('complete.mp3.manifest.json')!.toString()).map((c: { index: number }) => c.index)).toEqual([0, 25, 26]);
});
