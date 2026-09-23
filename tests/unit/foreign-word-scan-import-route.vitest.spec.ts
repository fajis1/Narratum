import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), select: vi.fn(), update: vi.fn(), readLexicon: vi.fn(),
  writeLexicon: vi.fn(), readProfiles: vi.fn(), findProfile: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: (...args: unknown[]) => mocks.auth(...args) }));
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => mocks.select() }) }) }),
    update: () => ({ set: () => ({ where: () => mocks.update() }) }),
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
