import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rows: [] as unknown[][], evidence: vi.fn(), fetch: vi.fn() }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: async () => mocks.rows.shift() || [] }) }) } }));
vi.mock('@/lib/server/admin/settings', () => ({ getRuntimeConfig: async () => ({ geminiApiKey: 'fixture-key' }) }));
vi.mock('@/lib/server/smart-audio-profiles', () => ({ readSmartAudioProfilesDocument: vi.fn() }));
vi.mock('@/lib/server/audiobooks/metadata-evidence', () => ({ collectMetadataEvidence: (...args: unknown[]) => mocks.evidence(...args) }));
vi.mock('@/lib/server/smart-audio/gemini-failover', () => ({ GEMINI_MODEL_FALLBACKS: {}, fetchGeminiWithRateLimitFallback: async ({ request }: { request: (key: string, model: string) => Promise<Response> }) => ({ response: await request('fixture-key', 'fixture-model') }) }));
vi.mock('@/lib/server/logger', () => ({ errorToLog: vi.fn(), serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { inferDocumentMetadataWithGemini } from '@/lib/server/audiobooks/metadata-inference';
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows = [[{ title: 'Book.pdf', author: 'Existing Author' }], [{ id: 'book', name: 'Book by Existing Author.pdf', type: 'pdf' }]];
  mocks.evidence.mockResolvedValue({ sampleText: 'By Zoë García\n' + 'x'.repeat(5000), sources: ['Original PDF page 1'], embeddedTitle: '', embeddedAuthors: [] });
  vi.stubGlobal('fetch', mocks.fetch);
});
function respond(metadata: unknown) {
  mocks.fetch.mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(metadata) }] } }] }));
}
test('Gemini sees filename and original front matter beyond the old 3500-character cutoff', async () => {
  respond({ title: 'Book', author: 'Zoë García' });
  const result = await inferDocumentMetadataWithGemini({ bookId: 'book', userId: 'owner' });
  const prompt = JSON.parse(mocks.fetch.mock.calls[0][1].body).contents[0].parts[0].text;
  expect(prompt).toContain('Book by Existing Author.pdf');
  expect(prompt).toContain('x'.repeat(5000));
  expect(prompt).toContain('Do not mistake cited scholars');
  expect(result).toMatchObject({ author: 'Zoë García', authorIdentified: true, evidenceSources: ['Original PDF page 1'] });
});
test('unknown model authors never overwrite a known catalog author', async () => {
  respond({ title: 'Book', author: 'Unknown Author' });
  expect(await inferDocumentMetadataWithGemini({ bookId: 'book', userId: 'owner' })).toMatchObject({ author: 'Existing Author', authorIdentified: true });
});
test('EPUB author metadata is retained even when Gemini omits or guesses the author', async () => {
  mocks.evidence.mockResolvedValue({ sampleText: 'EPUB metadata', sources: ['EPUB catalog metadata'], embeddedTitle: 'EPUB Title', embeddedAuthors: ['First Author', 'Second Author'] });
  respond({ author: 'Cited Scholar' });
  expect(await inferDocumentMetadataWithGemini({ bookId: 'book', userId: 'owner' })).toMatchObject({ title: 'EPUB Title', author: 'First Author, Second Author' });
});
test('no available author is explicitly unidentified, without inventing Unknown Author', async () => {
  mocks.rows = [[{ title: 'Book.pdf', author: 'Unknown Author' }], [{ id: 'book', name: 'Book.pdf', type: 'pdf' }]];
  respond({ author: 'Unknown Author' });
  expect(await inferDocumentMetadataWithGemini({ bookId: 'book', userId: 'owner' })).toMatchObject({ author: '', authorIdentified: false });
});
