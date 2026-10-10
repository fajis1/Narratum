import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), select: vi.fn(), update: vi.fn(), readLexicon: vi.fn(),
  writeLexicon: vi.fn(), readProfiles: vi.fn(), findProfile: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: (...args: unknown[]) => mocks.auth(...args) }));
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.select() }) }) }),
    update: () => ({ set: (values: unknown) => ({ where: () => mocks.update(values) }) }),
  },
}));
vi.mock('@/lib/server/smart-audio/book-lexicon', () => ({
  readBookLexicon: (...args: unknown[]) => mocks.readLexicon(...args),
  writeBookLexicon: (...args: unknown[]) => mocks.writeLexicon(...args),
}));
vi.mock('@/lib/server/smart-audio-profiles', () => ({
  readSmartAudioProfilesDocument: (...args: unknown[]) => mocks.readProfiles(...args),
  findSmartAudioProfileById: (...args: unknown[]) => mocks.findProfile(...args),
}));

import { POST } from '../../src/app/api/documents/scan-foreign-words/import/route';
import { isFlaggedForReview } from '@/lib/shared/foreign-word-scan-results';

const scan = {
  format: 'openreader-foreign-word-scan', version: 1, documentId: 'book',
  words: [{ word: 'λόγος', proposedPronunciation: '/loʊɡos/', proposedDefinition: 'word', omitDefinition: false }],
};
const request = (body: unknown) => new Request('http://localhost/api/documents/scan-foreign-words/import', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: 'owner' });
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed',
    words: [{ word: 'λόγος', contexts: ['A word in context.'], pronunciations: [] }],
  }) }]);
  mocks.readProfiles.mockResolvedValue({ selectedProfileId: 'profile' });
  mocks.findProfile.mockReturnValue({ id: 'profile', aiModel: 'gemini', pronunciations: {} });
  mocks.readLexicon.mockResolvedValue(null);
  mocks.update.mockResolvedValue(undefined);
  mocks.writeLexicon.mockResolvedValue(undefined);
});

test('rejects a scan belonging to another owner without reading or writing the lexicon', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'someone-else', documentId: 'book', status: 'completed', words: [{ word: 'λόγος' }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  expect(response.status).toBe(404);
  expect(mocks.readLexicon).not.toHaveBeenCalled();
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});

test('rejects an unknown word before writing the lexicon', async () => {
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan: {
    ...scan, words: [{ ...scan.words[0], word: 'ἀνήρ' }],
  } }) as never);
  expect(response.status).toBe(400);
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});

test('persists valid edits in the book lexicon and updates scan results', async () => {
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  expect(response.status).toBe(200);
  expect((await response.json()).imported).toBe(1);
  expect(mocks.writeLexicon).toHaveBeenCalledWith('owner', 'book', expect.objectContaining({
    entries: { 'λόγος': expect.objectContaining({
      pronunciation: '/loʊɡos/', definition: 'word', approvedRepair: true,
    }) },
  }));
  expect(mocks.update).toHaveBeenCalledOnce();
});

test('refuses an import that a profile override would silently supersede', async () => {
  mocks.findProfile.mockReturnValue({ id: 'profile', pronunciations: { 'λόγος': '/ˈlo.ɡus/' } });
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  expect(response.status).toBe(409);
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});

test('does not save edits for a trusted scan row requiring PDF source repair', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed',
    words: [{ word: 'λόγος', sourceStatus: 'needs_source_repair' }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  expect(response.status).toBe(400);
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});

test('does not trust a v1 import when Gemini marked the stored source insufficient', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed',
    words: [{ word: 'λόγος', sourceOutcome: 'insufficient_context' }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  expect(response.status).toBe(400);
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});

test('continues on error, imports valid words, and flags skipped words for review', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed',
    words: [
      { word: 'λόγος', contexts: ['A word in context.'], pronunciations: [] },
      { word: 'θεός', contexts: ['God in context.'], pronunciations: [] },
    ],
  }) }]);
  const multiWordScan = {
    format: 'openreader-foreign-word-scan', version: 2, documentId: 'book',
    words: [
      { word: 'λόγος', proposedPronunciation: '/loʊɡos/', proposedDefinition: 'divine word', omitDefinition: false },
      { word: 'θεός', proposedPronunciation: 'not IPA', proposedDefinition: 'God', omitDefinition: false },
    ],
  };
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan: multiWordScan }) as never);
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.imported).toBe(1);
  expect(data.skipped).toEqual([
    { word: 'θεός', reason: 'Invalid Kokoro pronunciation for θεός.' },
  ]);
  // Lexicon received only the valid word
  expect(mocks.writeLexicon).toHaveBeenCalledWith('owner', 'book', expect.objectContaining({
    entries: {
      'λόγος': expect.objectContaining({ pronunciation: '/loʊɡos/', definition: 'divine word' }),
    },
  }));
  // Job was updated with the skipped word flagged for review
  expect(data.words.find((w: { word: string }) => w.word === 'θεός')).toMatchObject({
    word: 'θεός',
    sourceStatus: 'source_review_recommended',
    definitionNeedsReview: true,
    importWarning: 'Invalid Kokoro pronunciation for θεός.',
    qualityFlags: ['import_validation_failed'],
  });
});

test('saves review flags when all edits fail if continueOnError is requested', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed',
    words: [{ word: 'θεός', contexts: ['God in context.'], pronunciations: [] }],
  }) }]);
  const failingScan = {
    format: 'openreader-foreign-word-scan', version: 2, documentId: 'book',
    words: [
      { word: 'θεός', proposedPronunciation: 'not IPA', proposedDefinition: 'God', omitDefinition: false },
    ],
  };
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan: failingScan, continueOnError: true }) as never);
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.imported).toBe(0);
  expect(data.skipped).toHaveLength(1);
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledOnce();
  expect(data.words[0]).toMatchObject({
    word: 'θεός',
    sourceStatus: 'source_review_recommended',
    definitionNeedsReview: true,
    importWarning: 'Invalid Kokoro pronunciation for θεός.',
  });
});

test('blocks guessed pronunciation for a historical malformed Hebrew key and records source repair', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed',
    words: [{ word: 'אבצ', sourceStatus: 'unverified', pronunciations: [] }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', continueOnError: true, scan: {
    ...scan, words: [{ word: 'אבצ', proposedPronunciation: '/ab/', sourceStatus: 'unverified' }],
  } }) as never);
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.imported).toBe(0);
  expect(result.words[0]).toMatchObject({ word: 'אבצ', sourceStatus: 'needs_source_repair', sourceOutcome: 'needs_source_repair' });
  expect(result.skipped[0].reason).toContain('source repair');
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});
test('imports a safe Ethiopic pronunciation through the document-scoped path', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed', words: [{ word: 'ኵሎ' }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan: {
    ...scan, words: [{ word: 'ኵሎ', proposedPronunciation: '/kulo/' }],
  } }) as never);
  expect(response.status).toBe(200);
  expect((await response.json()).imported).toBe(1);
  expect(mocks.writeLexicon).toHaveBeenCalledWith('owner', 'book', expect.objectContaining({
    entries: { 'ኵሎ': expect.objectContaining({ term: 'ኵሎ', pronunciation: '/kulo/', language: 'other' }) },
  }));
});

test('cannot spoof source approval to import a Latinized OCR alias into the document lexicon', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed',
    words: [{ word: 'xatagew', latinizedOcrCandidate: true, sourceStatus: 'source_review_recommended', sourceOutcome: 'valid_word' }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', continueOnError: true, scan: {
    ...scan, words: [{ word: 'xatagew', proposedPronunciation: '/katɑrɡeo/', proposedDefinition: 'abolish', sourceStatus: 'verified_document_reading', latinizedOcrCandidate: false }],
  } }) as never);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ imported: 0, skipped: [{ word: 'xatagew', reason: expect.stringContaining('source repair') }] });
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});

test('successful partial imports remove only saved terms from persisted manual review, including after reopening', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    id: 'job', userId: 'owner', documentId: 'book', status: 'completed', total: 3, completed: 3, resolved: 0,
    manualReviewTerms: ['λόγος', 'θεός', 'ἀνήρ'], manualReviewCount: 3,
    words: [{ word: 'λόγος' }, { word: 'θεός' }, { word: 'ἀνήρ' }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', continueOnError: true, scan: {
    ...scan, words: [scan.words[0], { word: 'θεός', proposedPronunciation: 'not IPA' }],
  } }) as never);
  const data = await response.json();
  expect(data).toMatchObject({ imported: 1, skipped: [{ word: 'θεός' }],
    job: { manualReviewTerms: ['θεός', 'ἀνήρ'], manualReviewCount: 2, resolved: 0 } });
  const saved = JSON.parse(mocks.update.mock.calls[0][0].valueJson);
  expect(saved.manualReviewTerms).toEqual(['θεός', 'ἀνήρ']);
  expect(saved.manualReviewCount).toBe(2);
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify(saved) }]);
  const again = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  expect((await again.json()).job.manualReviewTerms).toEqual(['θεός', 'ἀνήρ']);
});

test('a corrected re-import clears import-only flags and restores the original source status', async () => {
  const job = { userId: 'owner', documentId: 'book', status: 'completed', manualReviewTerms: ['λόγος'],
    words: [{ word: 'λόγος', sourceStatus: 'unverified', qualityFlags: ['extraction_note'] }] };
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify(job) }]);
  const failed = await POST(request({ documentId: 'book', jobId: 'job', continueOnError: true,
    scan: { ...scan, words: [{ word: 'λόγος', proposedPronunciation: 'not IPA' }] } }) as never);
  const failedData = await failed.json();
  expect(isFlaggedForReview(failedData.words[0])).toBe(true);
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify(failedData.job) }]);
  const corrected = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  const data = await corrected.json();
  expect(data.words[0]).toMatchObject({ sourceStatus: 'unverified', qualityFlags: ['extraction_note'], importWarning: null });
  expect(isFlaggedForReview(data.words[0])).toBe(false);
  expect(data.job.manualReviewTerms).toEqual([]);
});

test('successful edits retain independent source-review evidence while clearing stale import flags', async () => {
  mocks.select.mockResolvedValue([{ valueJson: JSON.stringify({
    userId: 'owner', documentId: 'book', status: 'completed', manualReviewTerms: ['λόγος'],
    words: [{ word: 'λόγος', sourceStatus: 'source_review_recommended',
      importWarning: 'Earlier invalid definition', qualityFlags: ['ocr_suspect', 'import_validation_failed'] }],
  }) }]);
  const response = await POST(request({ documentId: 'book', jobId: 'job', scan }) as never);
  const data = await response.json();
  expect(data.imported).toBe(1);
  expect(data.words[0]).toMatchObject({ sourceStatus: 'source_review_recommended', qualityFlags: ['ocr_suspect'], importWarning: null });
  expect(isFlaggedForReview(data.words[0])).toBe(true);
});

test('omitting a definition still requires a usable pronunciation', async () => {
  const response = await POST(request({ documentId: 'book', jobId: 'job', continueOnError: true,
    scan: { ...scan, words: [{ word: 'λόγος', proposedPronunciation: null, proposedDefinition: null, omitDefinition: true }] },
  }) as never);
  const data = await response.json();
  expect(data.imported).toBe(0);
  expect(data.skipped[0].reason).toContain('A valid pronunciation is needed');
  expect(mocks.writeLexicon).not.toHaveBeenCalled();
});
