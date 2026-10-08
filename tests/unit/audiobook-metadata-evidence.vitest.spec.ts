import { beforeEach, expect, test, vi } from 'vitest';
import JSZip from 'jszip';
const mocks = vi.hoisted(() => ({ artifact: vi.fn(), blob: vi.fn(), files: new Map<string, string>(), unavailable: new Set<string>() }));
vi.mock('@/lib/server/pdf-parse/artifact', () => ({ readCurrentParsedPdfArtifact: (...args: unknown[]) => mocks.artifact(...args) }));
vi.mock('@/lib/server/documents/blobstore', () => ({ getDocumentBlob: (...args: unknown[]) => mocks.blob(...args) }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  listAudiobookObjects: async () => [...mocks.files.keys()].map(fileName => ({ fileName })),
  getAudiobookObjectBuffer: async (_book: string, _user: string, file: string) => {
    if (mocks.unavailable.has(file)) throw new Error('Missing');
    return Buffer.from(mocks.files.get(file) || '');
  },
}));
import { collectMetadataEvidence } from '@/lib/server/audiobooks/metadata-evidence';
const input = { bookId: 'book', userId: 'owner', namespace: 'fixture' };
beforeEach(() => { vi.clearAllMocks(); mocks.files.clear(); mocks.unavailable.clear(); mocks.artifact.mockResolvedValue(null); });

test('PDF inference uses original extracted front matter even when narrated text omits the author', async () => {
  mocks.artifact.mockResolvedValue({ parsed: { pages: [
    { pageNumber: 1, blocks: [{ text: 'A Scholarly Book' }] },
    { pageNumber: 2, blocks: [{ text: 'By Zoë García\nCopyright 2024' }] },
  ] } });
  mocks.files.set('0001__text.txt', 'Chapter One. The story begins.');
  const evidence = await collectMetadataEvidence({ ...input, document: { id: 'book', type: 'pdf' } });
  expect(evidence.sampleText).toContain('By Zoë García');
  expect(evidence.sources).toContain('Original PDF page 2');
  expect(mocks.artifact).toHaveBeenCalledWith({ documentId: 'book', namespace: 'fixture' });
  expect(mocks.blob).not.toHaveBeenCalled();
});

test('original chapters take precedence; missing originals fall back without aborting sampling', async () => {
  mocks.files.set('0002__text.txt', 'Cleaned prose.');
  mocks.files.set('0002__original.txt', 'Title page\nBy Jane Example');
  mocks.files.set('0010__original.txt', 'Missing original'); mocks.unavailable.add('0010__original.txt');
  mocks.files.set('0010__text.txt', 'Later cleaned chapter');
  const evidence = await collectMetadataEvidence(input);
  expect(evidence.sampleText).toContain('By Jane Example');
  expect(evidence.sampleText).not.toContain('Cleaned prose.');
  expect(evidence.sampleText).toContain('Later cleaned chapter');
});

test('PDF without extracted artifacts never submits printable raw PDF bytes as book text', async () => {
  mocks.blob.mockResolvedValue(Buffer.from('%PDF binary objects /Author (wrong name)'));
  const evidence = await collectMetadataEvidence({ ...input, document: { id: 'book', type: 'pdf' } });
  expect(evidence.sampleText).toBe('');
  expect(mocks.blob).not.toHaveBeenCalled();
});

test('EPUB reads real OPF author metadata, roles, and front matter instead of ZIP bytes', async () => {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
  zip.file('OPS/book.opf', `<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><metadata>
    <dc:title>A Book</dc:title><dc:creator opf:role="aut">Zoë García</dc:creator><dc:creator>John Example</dc:creator>
    <dc:creator opf:role="edt">Editor Only</dc:creator><dc:creator id="translator">Translator Only</dc:creator>
    <meta property="role" refines="#translator">trl</meta></metadata>
    <manifest><item id="cover" href="cover.xhtml"/></manifest><spine><itemref idref="cover"/></spine></package>`);
  zip.file('OPS/cover.xhtml', '<html><p>A Book</p><p>By Zoë García</p></html>');
  mocks.blob.mockResolvedValue(await zip.generateAsync({ type: 'nodebuffer' }));
  const evidence = await collectMetadataEvidence({ ...input, document: { id: 'book', type: 'epub' } });
  expect(evidence.embeddedAuthors).toEqual(['Zoë García', 'John Example']);
  expect(evidence.embeddedTitle).toBe('A Book');
  expect(evidence.sampleText).toContain('By Zoë García');
  expect(evidence.sampleText).not.toContain('Translator Only');
});

test('sampling remains bounded for large front matter and many audiobook chunks', async () => {
  mocks.artifact.mockResolvedValue({ parsed: { pages: Array.from({ length: 20 }, (_, index) => ({ pageNumber: index + 1, blocks: [{ text: 'x'.repeat(50000) }] })) } });
  for (let index = 1; index <= 100; index++) mocks.files.set(`${String(index).padStart(4, '0')}__text.txt`, 'y'.repeat(20000));
  const evidence = await collectMetadataEvidence({ ...input, document: { id: 'book', type: 'pdf' } });
  expect(evidence.sampleText.length).toBeLessThanOrEqual(12000);
  expect(evidence.sources).not.toContain('Original PDF page 7');
});
