import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as schema from '@/db/schema_sqlite';

const mocks = vi.hoisted(() => ({ db: undefined as unknown as ReturnType<typeof drizzle>, tts: vi.fn(), nats: vi.fn(), gemini: vi.fn(), blobs: new Map<string, Buffer>(), source: vi.fn(), quota: vi.fn() }));
vi.mock('@/db', () => ({ get db() { return mocks.db; } }));
vi.mock('@/db/schema', async () => import('../../src/db/schema_sqlite'));
vi.mock('@/lib/server/logger', () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, errorToLog: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: async () => ({ userId: 'owner' }) }));
vi.mock('@/lib/server/tasks/engine', () => ({ runTaskNow: async () => {} }));
vi.mock('@/lib/server/access/audiobook-quota', () => ({ consumeAudiobookCredit: mocks.quota, checkMonthlyAudiobookQuota: mocks.quota, recordMonthlyAudiobookUsage: mocks.quota }));
vi.mock('@/lib/server/audiobooks/system-monitor', () => ({ checkSystemResources: async () => ({ ok: true }) }));
vi.mock('@/lib/server/runtime-config', () => ({ getResolvedRuntimeConfig: async () => ({ defaultTtsProvider: 'custom-openai', ttsUpstreamMaxRetries: 0 }) }));
vi.mock('@/lib/server/admin/resolve-credentials', () => ({ resolveTtsCredentials: async () => ({ provider: 'custom-openai', apiKey: 'test-secret', adminRecord: { defaultModel: 'kokoro' } }) }));
vi.mock('@/lib/server/documents/blobstore', () => ({ getDocumentBlob: mocks.source }));
vi.mock('@/lib/server/audiobooks/segmented-tts', () => ({ generateSegmentedAudiobookTtsBuffer: mocks.tts }));
vi.mock('@/lib/server/audiobooks/post-generation-repair', () => ({ runPostGenerationPronunciationSweep: async () => ({}) }));
vi.mock('@/lib/server/smart-audio-profiles', () => ({
  readSmartAudioProfilesDocument: async () => ({ profiles: [] }),
  findSmartAudioProfileById: () => ({ id: 'profile', workerMode: 'standard', geminiApiKey: 'test-secret', aiModel: 'gemini-test', pronunciations: {} }),
}));
vi.mock('@/lib/server/smart-audio/gemini-failover', () => ({ fetchGeminiWithRateLimitFallback: mocks.gemini }));
vi.mock('nats', () => ({ connect: async () => ({ request: mocks.nats, close: async () => {} }), StringCodec: () => ({ encode: (s: string) => Buffer.from(s), decode: (b: Buffer) => b.toString() }) }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  getAudiobookObjectBuffer: async (_book: string, _user: string, name: string) => { const b = mocks.blobs.get(name); if (!b) throw Object.assign(new Error('Not found'), { code: 'NoSuchKey' }); return b; },
  isMissingBlobError: (e: { code?: string }) => e.code === 'NoSuchKey',
  putAudiobookObject: async (_book: string, _user: string, name: string, body: Buffer) => { mocks.blobs.set(name, body); },
  listAudiobookObjects: async () => [...mocks.blobs].map(([fileName, b]) => ({ fileName, size: b.length })),
}));
import { processAudiobookQueue } from '@/lib/server/audiobooks/worker';
import { PUT } from '@/app/api/audiobooks/queue/route';
import { GET as failureLog } from '@/app/api/audiobook/failure-log/route';
import { readAudiobookCompleteness, assertAudiobookComplete } from '@/lib/server/audiobooks/completeness';
import { classifyAudiobookFailure, planProviderRetry, PROVIDER_RETRY_BUDGET } from '@/lib/shared/audiobook-processing-failure';
import { resolveAudiobookJobDescriptiveState } from '@/lib/shared/audiobook-job-status';

let sqlite: Database.Database;
const globalState = globalThis as typeof globalThis & { __worker_booted?: boolean };
let oldBoot: boolean | undefined;
const source = 'The sentence must remain.';
const jobSettings = () => (mocks.db.select().from(schema.audiobookJobs).where(eq(schema.audiobookJobs.id, 'job')).get()!.settingsJson as Record<string, unknown>);
const job = () => mocks.db.select().from(schema.audiobookJobs).where(eq(schema.audiobookJobs.id, 'job')).get()!;
function expireCooldown() {
  const settings = jobSettings(); settings.nextAttemptAt = Date.now() - 1;
  mocks.db.update(schema.audiobookJobs).set({ settingsJson: settings }).where(eq(schema.audiobookJobs.id, 'job')).run();
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.blobs.clear(); oldBoot = globalState.__worker_booted; globalState.__worker_booted = true;
  sqlite = new Database(':memory:');
  for (const table of [schema.documents, schema.audiobookJobs, schema.audiobooks, schema.audiobookChapters, schema.documentSettings, schema.adminSettings]) {
    const config = getTableConfig(table);
    sqlite.exec(`CREATE TABLE "${config.name}" (${config.columns.map(c => `"${c.name}" ${c.getSQLType()}`).join(', ')}${config.name === 'audiobook_chapters' ? ', UNIQUE(id, user_id)' : ''})`);
  }
  mocks.db = drizzle(sqlite);
  mocks.db.insert(schema.documents).values({ id: 'book', userId: 'owner', name: 'Book', type: 'txt', size: 1, lastModified: 1, filePath: 'test' }).run();
  mocks.db.insert(schema.audiobookJobs).values({ id: 'job', userId: 'owner', documentId: 'book', status: 'queued', settingsJson: { useSmartAudio: true, smartAudioProfileId: 'profile', format: 'mp3', expectedChapterIndexes: [0, 1], sourceRecoverySnapshot: { schemaVersion: 1, revision: 0, documentId: 'book', occurrences: [] }, marker: 'preserved' }, createdAt: 1, updatedAt: 1 }).run();
  mocks.blobs.set('audiobook.source-chapters.json', Buffer.from(JSON.stringify({ schemaVersion: 1, chapters: [{ index: 0, title: 'Done', text: 'Already recorded.' }, { index: 1, title: 'Missing', text: source }] })));
  mocks.db.insert(schema.audiobooks).values({ id: 'book', userId: 'owner', title: 'Book', hasSmartAudio: true }).run();
  mocks.db.insert(schema.audiobookChapters).values({ id: 'done', bookId: 'book', userId: 'owner', chapterIndex: 0, title: 'Done', filePath: '0001__Done.mp3', format: 'mp3' }).run();
  mocks.blobs.set('0001__Done.mp3', Buffer.from('existing audio'));
  mocks.nats.mockImplementation(async (_subject: string, payload: Buffer) => ({ data: Buffer.from(JSON.stringify({ status: 'success', cleaned_text: JSON.parse(payload.toString()).raw_text })) }));
  mocks.tts.mockResolvedValue(Buffer.from('new audio')); mocks.source.mockRejectedValue(new Error('Must not reparse pinned source'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response()));
});
afterEach(() => { sqlite.close(); globalState.__worker_booted = oldBoot; vi.unstubAllGlobals(); });

test.each([429, 503])('Gemini HTTP %s persists cooldown, retains diagnostics, never creates false review, and skips recorded chapters', async status => {
  mocks.nats.mockResolvedValue({ data: Buffer.from(JSON.stringify({ status: 'success', cleaned_text: 'The λόγος remains.' })) });
  mocks.gemini.mockResolvedValue({ response: new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status, headers: { 'retry-after': '900' } }), usedModel: 'gemini-test' });
  await processAudiobookQueue();
  expect(job().status).toBe('queued');
  expect(jobSettings()).toMatchObject({ marker: 'preserved', providerRetry: { count: 1, failure: { failureCategory: 'provider_transient', provider: 'gemini', httpStatus: status, stage: 'targeted_pronunciation_repair', chapterIndex: 1 } } });
  expect(jobSettings().nextAttemptAt).toBeGreaterThan(Date.now() + 890_000);
  expect(mocks.tts).not.toHaveBeenCalled(); expect([...mocks.blobs.keys()].some(n => n.endsWith('__pronunciation_failure.json'))).toBe(false);
  expect(mocks.nats).toHaveBeenCalledTimes(1); expect(mocks.blobs.get('0001__Done.mp3')!.toString()).toBe('existing audio');
  globalState.__worker_booted = false; await processAudiobookQueue();
  expect(mocks.nats).toHaveBeenCalledTimes(1); expect(job().status).toBe('queued');
});

test('Kokoro readiness failure defers, reuses validated cleanup, recovers without duplicate recordings and retains history', async () => {
  mocks.tts.mockRejectedValueOnce(Object.assign(new Error('Kokoro did not become ready before the startup timeout'), { status: 503 }));
  await processAudiobookQueue();
  expect(job().status).toBe('queued'); expect(jobSettings()).toMatchObject({ providerRetry: { failure: { provider: 'custom-openai', model: 'kokoro', httpStatus: 503, stage: 'tts_recording' } } });
  expect(mocks.blobs.has('0002__validated.json')).toBe(true); expect(mocks.nats).toHaveBeenCalledTimes(1);
  const waiting = await failureLog(new NextRequest('http://localhost/api/audiobook/failure-log?bookId=book'));
  expect((await waiting.json()).failures[0]).toMatchObject({ state: 'retry_scheduled', failureCategory: 'provider_transient', retryScheduled: true });
  const pinned = mocks.blobs.get('audiobook.source-chapters.json'); expireCooldown(); globalState.__worker_booted = false;
  await processAudiobookQueue();
  expect(job().status).toBe('completed'); expect(jobSettings().providerRetry).toBeUndefined();
  expect(mocks.nats).toHaveBeenCalledTimes(1); expect(mocks.tts).toHaveBeenCalledTimes(2); expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.blobs.get('audiobook.source-chapters.json')).toEqual(pinned);
  expect(mocks.db.select().from(schema.audiobookChapters).all().map(c => c.chapterIndex).sort()).toEqual([0, 1]);
  const recovered = await failureLog(new NextRequest('http://localhost/api/audiobook/failure-log?bookId=book'));
  expect((await recovered.json()).failures[0]).toMatchObject({ state: 'recovered_history', retryScheduled: false });
  expect(mocks.blobs.has('0002__provider_failure.json')).toBe(true);
});

test('chapter row with its referenced recording is skipped and counted as complete', async () => {
  mocks.db.insert(schema.audiobookChapters).values({ id: 'missing-audio-row', bookId: 'book', userId: 'owner', chapterIndex: 1, title: 'Missing', filePath: '0002__Missing.mp3', format: 'mp3' }).run();
  mocks.blobs.set('0002__Missing.mp3', Buffer.from('verified audio'));

  await processAudiobookQueue();

  expect(job().status).toBe('completed');
  expect(mocks.tts).not.toHaveBeenCalled();
  expect(mocks.nats).not.toHaveBeenCalled();
  expect(mocks.blobs.get('0002__Missing.mp3')!.toString()).toBe('verified audio');
  expect(mocks.db.select().from(schema.audiobookChapters).all()).toHaveLength(2);
});

test('missing referenced audio is regenerated, updates its existing row, and restores completeness', async () => {
  mocks.db.insert(schema.audiobookChapters).values({ id: 'chapter-one-row', bookId: 'book', userId: 'owner', chapterIndex: 1, title: 'Old title', filePath: '0002__Missing.mp3', format: 'mp3' }).run();

  await processAudiobookQueue();

  const rows = mocks.db.select().from(schema.audiobookChapters).all();
  expect(job().status).toBe('completed');
  expect(mocks.tts).toHaveBeenCalledTimes(1);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.chapterIndex === 1)).toMatchObject({ id: 'chapter-one-row', filePath: '0002__Missing.mp3', title: 'Missing' });
  expect(mocks.blobs.has('0002__Missing.mp3')).toBe(true);
  expect((await readAudiobookCompleteness('book', 'owner', null)).complete).toBe(true);
  expect(mocks.blobs.get('0001__Done.mp3')!.toString()).toBe('existing audio');
});

test('repeated retries for a missing referenced file reuse the row and eventually restore completeness', async () => {
  mocks.db.insert(schema.audiobookChapters).values({ id: 'chapter-one-row', bookId: 'book', userId: 'owner', chapterIndex: 1, title: 'Missing', filePath: '0002__Missing.mp3', format: 'mp3' }).run();
  mocks.tts.mockRejectedValueOnce(Object.assign(new Error('Kokoro unavailable'), { status: 503 }));

  await processAudiobookQueue();
  expect(job().status).toBe('queued');
  expect(mocks.db.select().from(schema.audiobookChapters).all().filter(row => row.chapterIndex === 1)).toHaveLength(1);
  expireCooldown();
  await processAudiobookQueue();

  const rows = mocks.db.select().from(schema.audiobookChapters).all().filter(row => row.chapterIndex === 1);
  expect(job().status).toBe('completed');
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe('chapter-one-row');
  expect((await readAudiobookCompleteness('book', 'owner', null)).complete).toBe(true);
  expect(mocks.nats).toHaveBeenCalledTimes(1);
});

test('unexpected existing chapter reference is reported without choosing or overwriting another audio object', async () => {
  mocks.db.insert(schema.audiobookChapters).values({ id: 'chapter-one-row', bookId: 'book', userId: 'owner', chapterIndex: 1, title: 'Missing', filePath: 'unrelated.mp3', format: 'mp3' }).run();
  mocks.blobs.set('0002__Different.mp3', Buffer.from('unverified audio'));

  await processAudiobookQueue();

  expect(job().status).toBe('error');
  expect(jobSettings()).toMatchObject({ lastProcessingFailure: { stage: 'chapter_file_reference_conflict', chapterIndex: 1 } });
  expect(mocks.tts).not.toHaveBeenCalled();
  expect(mocks.blobs.get('0002__Different.mp3')!.toString()).toBe('unverified audio');
  expect(mocks.db.select().from(schema.audiobookChapters).all()).toHaveLength(2);
});

test('a present chapter file with stale format metadata is neither skipped nor treated as complete', async () => {
  mocks.db.insert(schema.audiobookChapters).values({ id: 'chapter-one-row', bookId: 'book', userId: 'owner', chapterIndex: 1, title: 'Missing', filePath: '0002__Missing.mp3', format: 'm4b' }).run();
  mocks.blobs.set('0002__Missing.mp3', Buffer.from('unverified recording'));

  await processAudiobookQueue();

  expect(job().status).toBe('error');
  expect(jobSettings()).toMatchObject({ lastProcessingFailure: { stage: 'chapter_file_reference_conflict', chapterIndex: 1 } });
  expect((await readAudiobookCompleteness('book', 'owner', null)).missingChapterIndexes).toContain(1);
  expect(mocks.tts).not.toHaveBeenCalled();
  expect(mocks.blobs.get('0002__Missing.mp3')!.toString()).toBe('unverified recording');
});

test('untracked audio for a missing chapter row is not overwritten', async () => {
  mocks.blobs.set('0002__Missing.mp3', Buffer.from('unverified recording'));

  await processAudiobookQueue();

  expect(job().status).toBe('error');
  expect(jobSettings()).toMatchObject({ lastProcessingFailure: { stage: 'chapter_audio_without_record', chapterIndex: 1 } });
  expect(mocks.tts).not.toHaveBeenCalled();
  expect(mocks.blobs.get('0002__Missing.mp3')!.toString()).toBe('unverified recording');
  expect(mocks.db.select().from(schema.audiobookChapters).all()).toHaveLength(1);
});

test('cancellation during missing-audio recovery preserves the row and does not schedule a retry', async () => {
  mocks.db.insert(schema.audiobookChapters).values({ id: 'chapter-one-row', bookId: 'book', userId: 'owner', chapterIndex: 1, title: 'Missing', filePath: '0002__Missing.mp3', format: 'mp3' }).run();
  mocks.tts.mockImplementationOnce(async () => {
    mocks.db.update(schema.audiobookJobs).set({ status: 'paused' }).where(eq(schema.audiobookJobs.id, 'job')).run();
    throw new Error('recording cancelled');
  });

  await processAudiobookQueue();

  expect(job().status).toBe('paused');
  expect(jobSettings().providerRetry).toBeUndefined();
  expect(mocks.db.select().from(schema.audiobookChapters).all().find(row => row.chapterIndex === 1)?.id).toBe('chapter-one-row');
});

test('permanent Gemini denial stops with configuration diagnostics and no manual IPA artifact', async () => {
  mocks.nats.mockResolvedValue({ data: Buffer.from(JSON.stringify({ status: 'success', cleaned_text: 'The λόγος remains.' })) });
  mocks.gemini.mockResolvedValue({ response: new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 }), usedModel: 'gemini-test' });
  await processAudiobookQueue();
  expect(job()).toMatchObject({ status: 'error', error: expect.stringContaining('configuration or access failure') });
  expect(jobSettings().nextAttemptAt).toBeUndefined(); expect(mocks.tts).not.toHaveBeenCalled();
  expect([...mocks.blobs.keys()].some(n => n.endsWith('__pronunciation_failure.json'))).toBe(false);
});

test('functioning Gemini with unacceptable IPA retains content review and cannot compile partial audio', async () => {
  mocks.nats.mockResolvedValue({ data: Buffer.from(JSON.stringify({ status: 'success', cleaned_text: 'The λόγος remains.' })) });
  mocks.gemini.mockResolvedValue({ response: new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ patches: [{ id: '0', replacement: '[λόγος](/λoɡos/)' }] }) }] } }] })), usedModel: 'gemini-test' });
  await processAudiobookQueue(); expect(job().status).toBe('error'); expect(job().error).toContain('Incomplete audiobook');
  expect(mocks.blobs.has('0002__pronunciation_failure.json')).toBe(true); expect(mocks.tts).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled(); await expect(assertAudiobookComplete('book', 'owner', null)).rejects.toThrow('Chapter content review');
});

test('repeated Kokoro outages exhaust a persistent bounded budget, with no rapid loop', async () => {
  mocks.tts.mockRejectedValue(Object.assign(new Error('503 status code (no body)'), { status: 503 }));
  for (let i = 0; i <= PROVIDER_RETRY_BUDGET; i++) { await processAudiobookQueue(); if (i < PROVIDER_RETRY_BUDGET) { expect(job().status).toBe('queued'); expireCooldown(); } }
  expect(job().status).toBe('error'); expect(job().error).toContain('retry budget exhausted'); expect(jobSettings()).toMatchObject({ providerRetry: { count: 7, exhausted: true } });
  expect(mocks.nats).toHaveBeenCalledTimes(1); await processAudiobookQueue(); expect(mocks.tts).toHaveBeenCalledTimes(7);
});

test('explicit same-job missing retry clears scheduling, preserves mappings/settings, skips recordings, and charges no quota', async () => {
  mocks.db.update(schema.audiobookJobs).set({ status: 'completed', error: '9 chapters require manual review before full-book download.', settingsJson: { ...jobSettings(), nextAttemptAt: Date.now() + 9e6 } }).where(eq(schema.audiobookJobs.id, 'job')).run();
  const result = await PUT(new NextRequest('http://localhost/api/audiobooks/queue', { method: 'PUT', body: JSON.stringify({ id: 'job' }) }));
  expect(result.status).toBe(200); expect(job().status).toBe('queued'); expect(jobSettings()).toMatchObject({ marker: 'preserved', expectedChapterIndexes: [0, 1] }); expect(jobSettings().nextAttemptAt).toBeUndefined(); expect(mocks.quota).not.toHaveBeenCalled();
  await processAudiobookQueue(); expect(job().status).toBe('completed'); expect(mocks.tts).toHaveBeenCalledTimes(1);
});

test('manual retry refuses another active job for the same book and cancellation does not restart', async () => {
  mocks.db.update(schema.audiobookJobs).set({ status: 'error' }).where(eq(schema.audiobookJobs.id, 'job')).run();
  mocks.db.insert(schema.audiobookJobs).values({ id: 'other', documentId: 'book', userId: 'owner', status: 'running', settingsJson: {}, updatedAt: Date.now() }).run();
  expect((await PUT(new NextRequest('http://localhost/api/audiobooks/queue', { method: 'PUT', body: JSON.stringify({ id: 'job' }) }))).status).toBe(409);
  mocks.db.update(schema.audiobookJobs).set({ status: 'paused' }).run(); await processAudiobookQueue(); expect(mocks.tts).not.toHaveBeenCalled();
});

test('nine missing recordings remain incomplete across restart and legacy completed status is presented honestly', async () => {
  mocks.db.update(schema.audiobookJobs).set({ settingsJson: { expectedChapterIndexes: Array.from({ length: 10 }, (_, i) => i) } }).where(eq(schema.audiobookJobs.id, 'job')).run();
  expect((await readAudiobookCompleteness('book', 'owner', null)).missingChapterIndexes).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(resolveAudiobookJobDescriptiveState({ status: 'completed', error: '9 chapters require manual review before full-book download.' }).badgeText).toBe('Incomplete');
});

 test.each([401, 403])('HTTP %s is permanent unless temporary quota evidence exists', status => {
  expect(classifyAudiobookFailure({ status }, { provider: 'gemini', stage: 'repair' }).failureCategory).toBe('provider_configuration');
 });
test('typed timeout and Retry-After are safe, classified and respected', () => {
  const f = classifyAudiobookFailure(Object.assign(new Error('secret credentials must never be persisted'), { name: 'TimeoutError' }), { provider: 'gemini', stage: 'repair' });
  expect(f.failureCategory).toBe('provider_transient'); expect(JSON.stringify(f)).not.toContain('secret');
  const quota = classifyAudiobookFailure({ status: 403, apiStatus: 'RESOURCE_EXHAUSTED', headers: new Headers({ 'retry-after': '7200' }) }, { provider: 'gemini', stage: 'repair' });
  expect(quota.failureCategory).toBe('provider_transient'); expect(planProviderRetry(quota, undefined, 1000).nextAttemptAt).toBe(7_201_000);
});

 test('Gemini transport timeout is deferred without linguistic review', async () => {
  mocks.nats.mockResolvedValue({ data: Buffer.from(JSON.stringify({ status: 'success', cleaned_text: 'The λόγος remains.' })) });
  mocks.gemini.mockRejectedValue(new DOMException('Timeout', 'TimeoutError'));
  await processAudiobookQueue();
  expect(job().status).toBe('queued'); expect(jobSettings()).toMatchObject({ providerRetry: { failure: { failureCategory: 'provider_transient', errorType: 'TimeoutError' } } });
  expect(mocks.blobs.has('0002__pronunciation_failure.json')).toBe(false);
 });
 test('permanent TTS credentials failure and unknown technical exceptions do not become manual pronunciation problems', async () => {
  mocks.tts.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
  await processAudiobookQueue(); expect(job().status).toBe('error'); expect(job().error).toContain('configuration or access failure');
  expect(mocks.blobs.has('0002__pronunciation_failure.json')).toBe(false);
  mocks.db.update(schema.audiobookJobs).set({ status: 'queued' }).where(eq(schema.audiobookJobs.id, 'job')).run();
  mocks.tts.mockRejectedValueOnce(new Error('Unexpected encoder error'));
  await processAudiobookQueue(); expect(job().status).toBe('error'); expect(jobSettings()).toMatchObject({ lastProcessingFailure: { failureCategory: 'technical_unknown', stage: 'tts_recording' } });
  expect(mocks.blobs.has('0002__pronunciation_failure.json')).toBe(false);
 });
 test('cancellation while waiting for Kokoro does not schedule automatic restart', async () => {
  mocks.tts.mockImplementationOnce(async () => {
    mocks.db.update(schema.audiobookJobs).set({ status: 'paused' }).where(eq(schema.audiobookJobs.id, 'job')).run();
    throw Object.assign(new Error('503 status code (no body)'), { status: 503 });
  });
  await processAudiobookQueue(); expect(job().status).toBe('paused'); expect(jobSettings().providerRetry).toBeUndefined();
 });
 test('an unsafe cached intermediate is rejected before recording', async () => {
  mocks.tts.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }));
  await processAudiobookQueue();
  const cache = JSON.parse(mocks.blobs.get('0002__validated.json')!.toString());
  cache.text = '[λόγος](/ˈloɡos/)'; mocks.blobs.set('0002__validated.json', Buffer.from(JSON.stringify(cache))); expireCooldown();
  await processAudiobookQueue(); expect(job().status).toBe('error'); expect(mocks.tts).toHaveBeenCalledTimes(1);
 });
 test('saved Review Workspace edits are preserved when a missing chapter is retried', async () => {
  mocks.tts.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { status: 503 }));
  await processAudiobookQueue(); mocks.blobs.set('0002__text.txt', Buffer.from('Reviewed manual edit.')); expireCooldown();
  await processAudiobookQueue(); expect(job().status).toBe('error'); expect(job().error).toContain('Review Workspace');
  expect(mocks.blobs.get('0002__text.txt')!.toString()).toBe('Reviewed manual edit.'); expect(mocks.nats).toHaveBeenCalledTimes(1); expect(mocks.tts).toHaveBeenCalledTimes(1);
 });
 test('a newer content failure on an existing recording remains active until a later recording receipt', async () => {
  mocks.blobs.set('0001__pronunciation_failure.json', Buffer.from(JSON.stringify({ createdAt: 100, errors: ['Invalid IPA'] })));
  mocks.blobs.set('0001__recording_state.json', Buffer.from(JSON.stringify({ recordedAt: 50 })));
  expect((await readAudiobookCompleteness('book', 'owner', null)).activeReviewChapterIndexes).toContain(0);
  mocks.blobs.set('0001__recording_state.json', Buffer.from(JSON.stringify({ recordedAt: 150 })));
  expect((await readAudiobookCompleteness('book', 'owner', null)).activeReviewChapterIndexes).not.toContain(0);
 });

test('wrapped upstream status and Retry-After remain available to foreground TTS consumers', async () => {
  const { AudiobookProcessingError } = await import('@/lib/shared/audiobook-processing-failure');
  const { getUpstreamStatus, getUpstreamRetryAfterSeconds } = await import('@/lib/server/tts/upstream-response');
  const cause = { status: 503, headers: new Headers({ 'retry-after': '600' }) };
  const error = new AudiobookProcessingError(classifyAudiobookFailure(cause, { provider: 'custom-openai', model: 'kokoro', stage: 'tts_recording' }), cause);
  expect(getUpstreamStatus(error)).toBe(503); expect(getUpstreamRetryAfterSeconds(error)).toBe(600);
});

test('replacement recordings reuse legacy IDs and concurrent new chapter commits do not duplicate indexes', async () => {
  const { persistAudiobookChapter } = await import('@/lib/server/audiobooks/chapter-record');
  await persistAudiobookChapter({ bookId: 'book', userId: 'owner', chapterIndex: 0, title: 'Reviewed', filePath: '0001__Reviewed.mp3', format: 'mp3' });
  const fresh = { bookId: 'book', userId: 'owner', chapterIndex: 1, title: 'Missing', filePath: '0002__Missing.mp3', format: 'mp3' };
  await Promise.all([persistAudiobookChapter(fresh), persistAudiobookChapter(fresh)]);
  const records = mocks.db.select().from(schema.audiobookChapters).all();
  expect(records).toHaveLength(2); expect(records.find(c => c.chapterIndex === 0)?.id).toBe('done');
  expect(records.filter(c => c.chapterIndex === 1)).toHaveLength(1);
});

test('SDK numeric HTTP codes and Kokoro readiness diagnostics retain their specific meaning', () => {
  expect(classifyAudiobookFailure({ code: 403, status: 'PERMISSION_DENIED' }, { provider: 'gemini', stage: 'repair' })).toMatchObject({ httpStatus: 403, failureCategory: 'provider_configuration' });
  expect(classifyAudiobookFailure(new Error('Kokoro did not become ready before the startup timeout'), { provider: 'custom-openai', model: 'kokoro', stage: 'tts_recording' })).toMatchObject({ failureCategory: 'provider_transient', providerCode: 'KOKORO_STARTUP_TIMEOUT', provider: 'custom-openai', model: 'kokoro' });
});

test('legacy recovery refuses changed chapter boundaries and preserves original successful recordings', async () => {
  mocks.blobs.delete('audiobook.source-chapters.json'); mocks.source.mockResolvedValueOnce(Buffer.from('Already recorded.'));
  await processAudiobookQueue(); expect(job().status).toBe('error');
  expect(jobSettings()).toMatchObject({ lastProcessingFailure: { stage: 'legacy_chapter_mapping_verification', failureCategory: 'technical_unknown' } });
  expect(mocks.blobs.get('0001__Done.mp3')!.toString()).toBe('existing audio'); expect(mocks.tts).not.toHaveBeenCalled(); expect(mocks.blobs.has('audiobook.source-chapters.json')).toBe(false);
});

test('permanent structured status wins over misleading timeout names; explicit cancellation is separate', () => {
  const error = Object.assign(new Error('Timeout-looking denial'), { status: 403, name: 'ReadTimeout' });
  expect(classifyAudiobookFailure(error, { provider: 'gemini', stage: 'repair' }).failureCategory).toBe('provider_configuration');
  expect(classifyAudiobookFailure(new DOMException('Timed out', 'AbortError'), { provider: 'gemini', stage: 'repair' }).failureCategory).toBe('provider_transient');
  expect(classifyAudiobookFailure(new DOMException('User stopped', 'AbortError'), { stage: 'repair', cancelled: true }).failureCategory).toBe('cancelled');
});
