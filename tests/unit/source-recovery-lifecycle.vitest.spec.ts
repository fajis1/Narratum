import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { execFileSync } from 'node:child_process';
import { resolveTestPython } from '../helpers/python';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ database: undefined as unknown as ReturnType<typeof drizzle>,
  tasks: [] as (() => Promise<void>)[], scanRows: [] as unknown[], scanner: vi.fn(), transport: vi.fn(),
  dictionary: vi.fn(), enrich: vi.fn(), globalPronunciations: vi.fn(), globalDefinitions: vi.fn(), readDefinitions: vi.fn(), book: vi.fn(), readBook: vi.fn(),
  render: vi.fn(), tts: vi.fn(), profile: { id: 'profile', name: 'Fixture', workerMode: 'narrator',
    aiModel: 'gemini-3.8-flash', geminiApiKey: 'fixture', pronunciations: {} } }));
vi.mock('@/db', () => ({ get db() { return mocks.database; } }));
vi.mock('@/db/schema', async () => import('../../src/db/schema_sqlite'));
vi.mock('next/server', async (original) => ({ ...await original<typeof import('next/server')>(), after: (task: () => Promise<void>) => mocks.tasks.push(task) }));
vi.mock('child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: async () => {
  mocks.scanner(); return { stdout: JSON.stringify(mocks.scanRows), stderr: '' };
} }) }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: async () => ({ userId: 'owner' }) }));
vi.mock('@/lib/server/documents/blobstore', () => ({ getDocumentBlob: async () => Buffer.from('mock PDF; extraction supplied by Python fixture') }));
vi.mock('@/lib/server/smart-audio-profiles', () => ({ readSmartAudioProfilesDocument: async () => ({ selectedProfileId: 'profile', profiles: [mocks.profile] }), findSmartAudioProfileById: () => mocks.profile }));
vi.mock('@/lib/server/smart-audio/gemini-failover', () => ({ fetchGeminiWithRateLimitFallback: mocks.transport }));
vi.mock('@/lib/server/smart-audio/sefaria-lexicon', () => ({ fetchLexiconEntry: mocks.dictionary, fetchLexiconEntries: mocks.enrich }));
vi.mock('@/lib/server/smart-audio/global-pronunciation-merge', () => ({ mergeGeneratedGlobalPronunciations: mocks.globalPronunciations }));
vi.mock('@/lib/server/smart-audio/global-definition-library', () => ({ readGlobalDefinitions: mocks.readDefinitions, mergeGlobalDefinitions: mocks.globalDefinitions }));
vi.mock('@/lib/server/smart-audio/book-lexicon', async (original) => ({ ...await original<typeof import('@/lib/server/smart-audio/book-lexicon')>(), readBookLexicon: mocks.readBook, writeBookLexicon: mocks.book }));
vi.mock('@/lib/server/tts/generate', () => ({ generateTTSBuffer: mocks.tts }));
vi.mock('@/lib/server/smart-audio/source-recovery-proposals', async (original) => {
  const actual = await original<typeof import('@/lib/server/smart-audio/source-recovery-proposals')>();
  return { ...actual, proposeSourceRecovery: (input: Parameters<typeof actual.proposeSourceRecovery>[0]) => actual.proposeSourceRecovery(input, { renderPages: mocks.render }) };
});

import { POST as saveProfiles } from '@/app/api/tts-settings/route';
import { POST as promote } from '@/app/api/tts/global-pronunciations/route';
import { POST as refine } from '@/app/api/tts/refine-pronunciations/route';
import { POST as scan } from '@/app/api/documents/scan-foreign-words/route';
import { POST as importScan } from '@/app/api/documents/scan-foreign-words/import/route';
import { POST as recover } from '@/app/api/documents/source-recovery/route';
import { readSourceRecovery } from '@/lib/server/smart-audio/source-recovery-store';
import { applySourceRecovery, assertRecoveredReadings, sourceRecoverySnapshot } from '@/lib/shared/source-recovery';
import { exportForeignWordScan } from '@/lib/shared/foreign-word-scan-transfer';
import { requiresForeignWordSourceRepair } from '@/lib/shared/foreign-word-source-integrity';
import { foreignWordCandidateCacheKey } from '@/lib/server/smart-audio/gemini-foreign-word-scan';
import { scanPronunciationActionError } from '@/lib/server/smart-audio/scan-pronunciation-guard';
import type { SmartAudioBookLexicon } from '@/types/document-settings';

type Row = { word: string; count: number; occurrences: { pdfPage: number; pageSourceStart: number }[]; [key: string]: unknown };
let sqlite: Database.Database;
let previousPostgres: string | undefined;
const request = (body: object) => new NextRequest('http://localhost/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: 'pdf', ...body }) });
function modelResponse(results: unknown) {
  mocks.transport.mockResolvedValue({ usedModel: 'fixture', response: new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(results) }] } }] })) });
}
async function rescan(): Promise<{ id: string; words: Row[]; errors: string[]; total: number; librarySkipped: number; manualReviewTerms: string[] }> {
  const response = await scan(request({ mode: 'all_foreign' }));
  expect(response.status).toBe(202);
  const { scanJobId: jobId } = await response.json();
  await mocks.tasks.shift()!();
  const stored = sqlite.prepare('SELECT value_json FROM admin_settings WHERE key = ?').get(`foreign_word_scan:${jobId}`) as { value_json: string };
  const job = JSON.parse(stored.value_json);
  expect(job.errors).toEqual([]);
  return job;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.tasks = [];
  mocks.profile.pronunciations = {};
  mocks.profile.workerMode = 'narrator';
  mocks.readBook.mockResolvedValue(null); mocks.readDefinitions.mockResolvedValue({});
  mocks.book.mockReset();
  previousPostgres = process.env.POSTGRES_URL; delete process.env.POSTGRES_URL;
  sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE documents (id text, user_id text, type text); CREATE TABLE admin_settings (key text PRIMARY KEY, value_json text NOT NULL, source text DEFAULT \'admin\', updated_at integer DEFAULT 1);');
  sqlite.prepare('INSERT INTO documents VALUES (?, ?, ?)').run('pdf', 'owner', 'pdf'); mocks.database = drizzle(sqlite);
  mocks.enrich.mockResolvedValue(new Map()); mocks.dictionary.mockResolvedValue({ headword: 'καταργέω', source: 'perseus', lexicon: 'fixture', definitions: ['abolish'], morphology: 'present' });
  mocks.render.mockImplementation(async (_document: string, pages: { page: number }[]) => pages.map(({ page }) => ({ page, kind: 'page', data: 'mock-page-image' })));
  // Catch any accidental network call: providers and lexical services must use mocks.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external provider request'); }));
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); if (previousPostgres === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = previousPostgres; });

test('Python detection → real scan/proposal/approval APIs → stable rescan → reviewed audiobook source', async () => {
  const fixture = JSON.parse(execFileSync(resolveTestPython(), ['tests/fixtures/ocr_source_recovery.py'], { encoding: 'utf8' })) as { rows: Row[]; pages: { pageNumber: number; text: string }[] };
  mocks.scanRows = fixture.rows;
  expect(fixture.rows.find((row) => row.word === 'xatagew')?.latinizedOcrCandidate).toBe(true);
  for (const [word, count] of [['xatagyéw', 75], ['xataoyéw', 8], ['téAoc', 19]] as const) {
    const row = fixture.rows.find((row) => row.word === word)!;
    expect(row.count).toBe(count); expect(row.occurrences).toHaveLength(count);
    expect(new Set(row.occurrences.map((item) => `${item.pdfPage}:${item.pageSourceStart}`)).size).toBe(count);
  }
  // Old v13 cache cannot suppress a run of the current scanner.
  const cacheKey = foreignWordCandidateCacheKey({ userId: 'owner', documentId: 'pdf', mode: 'all_foreign', target: 100, query: null });
  for (const key of [cacheKey.replace(':v14:', ':v13:'), cacheKey]) {
    sqlite.prepare('INSERT INTO admin_settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify({ version: 13, words: [] }));
  }
  modelResponse(['xatagyéw', 'xataoyéw', 'téAoc', 'év'].map((term) => ({ term, pronunciations: [], sourceOutcome: 'needs_source_repair', ocrFragment: false,
    language: 'other', definition: null, definitionOmitted: true, confidence: 0, needsReview: true })));
  const initial = await rescan();
  expect(mocks.scanner).toHaveBeenCalledOnce();
  expect(initial.words.find((row) => row.word === 'xatagew')).toMatchObject({ sourceStatus: 'needs_source_repair', pronunciations: [], definition: null });
  let analysis = (await readSourceRecovery('owner', 'pdf'))!;
  expect(analysis.occurrences.filter((item) => item.surface === 'xatagyéw')).toHaveLength(75);
  const targets = analysis.occurrences.filter((item) => item.surface === 'xatagyéw').slice(0, 6);
  modelResponse(targets.map((item, index) => ({ id: item.id, correctedSurface: index === 0 ? 'καταργέω' : null, lemma: index === 0 ? 'καταργέω' : null,
    language: 'koine_greek', pronunciation: '/katɑrɡeo/', explanation: 'Mock visual proposal; other readings ambiguous' })));
  expect((await recover(request({ action: 'propose', revision: analysis.revision, groupId: targets[0].groupId }))).status).toBe(200);
  analysis = (await readSourceRecovery('owner', 'pdf'))!;
  const proposed = analysis.occurrences.find((item) => item.id === targets[0].id)!;
  expect(proposed).toMatchObject({ surface: 'xatagyéw', pdfPage: 1, status: 'proposed', proposal: { correctedSurface: 'καταργέω', lemma: 'καταργέω' } });
  expect(sourceRecoverySnapshot(analysis).occurrences).toEqual([]);
  expect((await recover(request({ action: 'approve', revision: analysis.revision, occurrenceId: proposed.id, sourceVerified: true }))).status).toBe(200);
  analysis = (await readSourceRecovery('owner', 'pdf'))!;
  const approvedSnapshot = sourceRecoverySnapshot(analysis);
  const providerCalls = mocks.transport.mock.calls.length;
  for (let pass = 0; pass < 2; pass++) {
    const job = await rescan();
    const raw = job.words.find((row) => row.word === 'xatagyéw')!;
    const corrected = job.words.find((row) => row.word === 'καταργέω')!;
    expect(raw).toMatchObject({ count: 74, sourceRecoveryCounts: { applied: 0, unmatched: 0, unresolved: 74 } });
    expect(requiresForeignWordSourceRepair(raw)).toBe(true);
    expect(corrected).toMatchObject({ count: 1, sourceStatus: 'verified_document_reading', sourceOutcome: 'valid_word',
      pronunciationSource: 'document', libraryPronunciation: '/katɑrɡeo/', sourceRecoveryCounts: { applied: 1, unmatched: 0, unresolved: 0 } });
    expect(requiresForeignWordSourceRepair(corrected)).toBe(false);
    expect(await scanPronunciationActionError('owner', { documentId: 'pdf', jobId: job.id }, 'xatagew', true)).toContain('Verify');
    expect(await scanPronunciationActionError('owner', { documentId: 'pdf', jobId: job.id }, 'καταργέω', true)).toContain('document-local');
    expect(await scanPronunciationActionError('owner', { documentId: 'pdf', jobId: job.id }, 'καταργέω')).toBeNull();
    const exported = exportForeignWordScan('pdf', job.words);
    expect(exported.words.filter((row) => ['xatagyéw', 'καταργέω'].includes(row.word)).reduce((sum, row) => sum + row.rawOccurrenceCount!, 0)).toBe(75);
    expect(exported.words.find((row) => row.word === 'καταργέω')).toMatchObject({ effectiveVerifiedWord: 'καταργέω', approvedAppliedOccurrenceCount: 1 });
    expect(sourceRecoverySnapshot((await readSourceRecovery('owner', 'pdf'))!)).toMatchObject({ occurrences: approvedSnapshot.occurrences });
  }
  expect(mocks.scanner).toHaveBeenCalledOnce(); expect(mocks.transport).toHaveBeenCalledTimes(providerCalls);
  const effective = applySourceRecovery(fixture.pages, approvedSnapshot, 'pdf');
  expect(effective.applied).toEqual([proposed.id]); expect(effective.unmatched).toEqual([]);
  const cleanupSource = effective.blocks.map((block) => block.text).join('\n');
  expect(cleanupSource.match(/καταργέω/gu)).toHaveLength(1); expect(cleanupSource.match(/xatagyéw/gu)).toHaveLength(74);
  expect(() => assertRecoveredReadings(cleanupSource, cleanupSource.replace('καταργέω', 'καταργούμενον'), approvedSnapshot)).toThrow('accepted PDF source reading');
  expect(() => assertRecoveredReadings(cleanupSource, cleanupSource, approvedSnapshot)).not.toThrow();
  expect(fixture.pages.map((page) => page.text).join('').match(/xatagyéw/gu)).toHaveLength(75);
  expect(mocks.globalPronunciations).not.toHaveBeenCalled(); expect(mocks.globalDefinitions).not.toHaveBeenCalled();
  expect(sqlite.prepare("SELECT key FROM admin_settings WHERE key = 'global_pronunciations'").get()).toBeUndefined();
}, 15000);


test('scan refinement, personal adoption and global promotion all reject saved unverified OCR evidence', async () => {
  sqlite.prepare('INSERT INTO admin_settings (key, value_json) VALUES (?, ?)').run('foreign_word_scan:job', JSON.stringify({
    userId: 'owner', documentId: 'pdf', status: 'completed', words: [
      { word: 'xatagew', latinizedOcrCandidate: true, sourceStatus: 'source_review_recommended', sourceOutcome: 'valid_word' },
      { word: 'καταργέω', sourceStatus: 'verified_document_reading', sourceRecoveryCounts: { applied: 1 } },
      { word: 'katargeo', sourceStatus: 'source_review_recommended', latinTransliterationCandidate: true },
    ],
  }));
  const scanContext = { documentId: 'pdf', jobId: 'job' };
  for (const word of ['xatagew', 'καταργέω']) {
    expect((await saveProfiles(request({ scanContext, smartAudioProfiles: [{ ...mocks.profile, pronunciations: { [word]: '/katɑrɡeo/' } }] }))).status).toBe(409);
    expect((await promote(request({ scanContext, word, phonetic: '/katɑrɡeo/', action: 'promote-personal-default' }))).status).toBe(409);
  }
  expect((await refine(request({ scanContext, word: 'xatagew', feedback: 'test fixture' }))).status).toBe(409);
  expect(mocks.transport).not.toHaveBeenCalled();
  expect(await scanPronunciationActionError('owner', scanContext, 'katargeo', true)).toBeNull();
  expect(sqlite.prepare('SELECT count(*) AS count FROM admin_settings').get()).toEqual({ count: 1 });
});

test('a stale global or personal pronunciation cannot make an ASCII OCR candidate trusted', async () => {
  mocks.profile.pronunciations = { xatagew: '/katɑrɡeo/' };
  const storedLibrary = JSON.stringify({ xatagew: ['/katɑrɡeo/'] });
  sqlite.prepare('INSERT INTO admin_settings (key, value_json) VALUES (?, ?)').run('global_pronunciations', storedLibrary);
  mocks.scanRows = [{ word: 'xatagew', count: 1, latinizedOcrCandidate: true,
    sourceStatus: 'source_review_recommended', occurrences: [{ surfaceTerm: 'xatagew', pdfPage: 1, pageSourceStart: 9,
      context: 'The word xatagew means abolish.', contextTargetStart: 9, contextTargetEnd: 16 }] }];
  const job = await rescan();
  expect(job.words[0]).toMatchObject({ sourceStatus: 'needs_source_repair', pronunciations: [], userOverride: null,
    libraryPronunciation: null, geminiRecommendedPronunciation: null, definition: null });
  expect(mocks.enrich).toHaveBeenCalledWith([]);
  expect(mocks.transport).not.toHaveBeenCalled(); expect(mocks.globalPronunciations).not.toHaveBeenCalled();
  expect(mocks.globalDefinitions).not.toHaveBeenCalled();
  expect(mocks.book).toHaveBeenCalledWith('owner', 'pdf', expect.objectContaining({ entries: {} }));
  expect(sqlite.prepare("SELECT value_json FROM admin_settings WHERE key = 'global_pronunciations'").get()).toEqual({ value_json: storedLibrary });
});

test('imported book-only pronunciations survive repeated scans without new Gemini work or global promotion', async () => {
  let lexicon: SmartAudioBookLexicon | null = null;
  mocks.readBook.mockImplementation(async () => lexicon);
  mocks.book.mockImplementation(async (_user: string, _document: string, saved: SmartAudioBookLexicon) => { lexicon = structuredClone(saved); });
  mocks.scanRows = [{ word: 'λόγος', count: 1, occurrences: [] }];
  sqlite.prepare('INSERT INTO admin_settings (key, value_json) VALUES (?, ?)').run('foreign_word_scan:original', JSON.stringify({
    id: 'original', userId: 'owner', documentId: 'pdf', status: 'completed', words: mocks.scanRows,
    manualReviewTerms: ['λόγος'], manualReviewCount: 1, total: 1, completed: 1, resolved: 0,
  }));
  const imported = await importScan(request({ jobId: 'original', scan: {
    format: 'openreader-foreign-word-scan', version: 2, documentId: 'pdf',
    words: [{ word: 'λόγος', proposedPronunciation: '/loʊɡos/', proposedDefinition: 'word' }],
  } }));
  expect(imported.status).toBe(200);
  expect(await imported.json()).toMatchObject({ imported: 1, job: { manualReviewTerms: [], manualReviewCount: 0 } });
  for (let pass = 0; pass < 2; pass++) {
    const job = await rescan();
    expect(job).toMatchObject({ total: 0, librarySkipped: 1, manualReviewTerms: [] });
    expect(job.words[0]).toMatchObject({ libraryPronunciation: '/loʊɡos/', pronunciationSource: 'document',
      pronunciations: [{ phonetic: '/loʊɡos/', isInGlobalLibrary: false }], definition: 'word', definitionNeedsReview: false });
    expect(lexicon!.entries['λόγος']).toMatchObject({ pronunciation: '/loʊɡos/', definition: 'word', approvedRepair: true });
  }
  expect(mocks.transport).not.toHaveBeenCalled(); expect(mocks.tts).not.toHaveBeenCalled();
  expect(mocks.globalPronunciations).not.toHaveBeenCalled(); expect(mocks.globalDefinitions).not.toHaveBeenCalled();
});

test('rescans prefer saved book choices over global choices, honor personal overrides and preserve explicit omissions', async () => {
  mocks.profile.workerMode = 'scholar';
  mocks.scanRows = [{ word: 'λόγος', count: 1, occurrences: [] }, { word: 'θεός', count: 1, occurrences: [] }];
  mocks.readBook.mockResolvedValue({ schemaVersion: 1, profileId: 'profile', entries: {
    'λόγος': { term: 'λόγος', pronunciation: '/loʊɡos/', definition: 'word', language: 'koine_greek', approvedRepair: true },
    'θεός': { term: 'θεός', pronunciation: '/θeos/', definition: null, definitionOmitted: true, language: 'koine_greek', approvedRepair: true },
  } });
  mocks.readDefinitions.mockResolvedValue({ 'θεός': 'God' });
  sqlite.prepare('INSERT INTO admin_settings (key, value_json) VALUES (?, ?)').run('global_pronunciations', JSON.stringify({ 'λόγος': ['/loɡus/'] }));
  const book = await rescan();
  expect(book.total).toBe(0);
  expect(book.words[0]).toMatchObject({ libraryPronunciation: '/loʊɡos/', pronunciationSource: 'document' });
  expect(book.words[1]).toMatchObject({ definition: null, definitionOmitted: true });
  mocks.profile.pronunciations = { 'λόγος': '/loɡus/' };
  const personal = await rescan();
  expect(personal.total).toBe(0);
  expect(personal.words[0]).toMatchObject({ libraryPronunciation: '/loɡus/', userOverride: '/loɡus/', pronunciationSource: 'personal' });
  expect(mocks.transport).not.toHaveBeenCalled();
});

test('a saved book pronunciation cannot resolve damaged OCR text', async () => {
  mocks.scanRows = [{ word: 'xatagew', count: 1, occurrences: [], latinizedOcrCandidate: true }];
  mocks.readBook.mockResolvedValue({ profileId: 'profile', entries: {
    xatagew: { term: 'xatagew', pronunciation: '/katɑrɡeo/', definition: 'abolish', approvedRepair: true },
  } });
  const job = await rescan();
  expect(job.words[0]).toMatchObject({ sourceStatus: 'needs_source_repair', pronunciations: [], libraryPronunciation: null, definition: null });
  expect(mocks.book).toHaveBeenCalledWith('owner', 'pdf', expect.objectContaining({ entries: {} }));
  expect(mocks.transport).not.toHaveBeenCalled();
});
