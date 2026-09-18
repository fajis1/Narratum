import { beforeEach, describe, expect, test, vi } from 'vitest';
import { uploadBookToAudiobookshelf } from '@/lib/server/audiobooks/audiobookshelf';

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  listAudiobookObjects: vi.fn(),
  getAudiobookObjectBuffer: vi.fn(),
  getDocumentBlob: vi.fn(),
  executeAudiobookCombine: vi.fn(),
  compileDocumentToEpub: vi.fn(),
  searchAudiobookshelfCandidates: vi.fn(),
  matchAudiobookshelfCandidateWithGemini: vi.fn(),
  resolveAudiobookshelfConfig: vi.fn(),
  triggerAudiobookshelfScan: vi.fn(),
  tagAudiobookshelfItem: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  listAudiobookObjects: mocks.listAudiobookObjects,
  getAudiobookObjectBuffer: mocks.getAudiobookObjectBuffer,
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  getDocumentBlob: mocks.getDocumentBlob,
}));

vi.mock('@/lib/server/audiobooks/combine', () => ({
  executeAudiobookCombine: mocks.executeAudiobookCombine,
}));

vi.mock('@/lib/server/audiobooks/epub-generator', () => ({
  compileDocumentToEpub: mocks.compileDocumentToEpub,
}));

describe('Audiobookshelf Companion eBook Pipeline & Guardrail', () => {
  let uploadedFormDataEntries: Array<[string, any]> = [];
  let fetchedUrls: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    uploadedFormDataEntries = [];
    fetchedUrls = [];

    // Mock Audiobookshelf config
    process.env.AUDIOBOOKSHELF_URL = 'http://abs.test:13378';
    process.env.AUDIOBOOKSHELF_TOKEN = 'test-token';
    process.env.AUDIOBOOKSHELF_LIBRARY_ID = 'lib-1';
    process.env.AUDIOBOOKSHELF_FOLDER_ID = 'folder-1';

    // Mock DB queries for book and doc
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
          then: (resolve: any) =>
            resolve([
              {
                id: 'book-1',
                userId: 'user-1',
                title: 'The Way of Kings',
                author: 'Brandon Sanderson',
                name: 'The Way of Kings.pdf',
                type: 'pdf',
              },
            ]),
        }),
      }),
    }));

    // Mock blobstore objects
    mocks.listAudiobookObjects.mockResolvedValue([
      { fileName: '0001__audio.m4b' },
      { fileName: '0001__text.txt' },
      { fileName: 'complete.m4b' },
      { fileName: 'complete.m4b.manifest.json' },
    ]);

    const manifestSignature = [
      { index: 0, fileName: '0001__audio.m4b', title: 'Chapter 1' },
    ];
    mocks.getAudiobookObjectBuffer.mockImplementation((_b, _u, fileName) => {
      if (fileName.includes('manifest')) {
        return Promise.resolve(Buffer.from(JSON.stringify(manifestSignature)));
      }
      return Promise.resolve(Buffer.from('fake-audio-bytes'));
    });

    mocks.getDocumentBlob.mockResolvedValue(Buffer.from('%PDF-1.4 fake pdf bytes'));
    mocks.compileDocumentToEpub.mockResolvedValue(Buffer.from('PK\x03\x04 fake epub zip bytes'));

    // Mock fetch for /api/upload
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      fetchedUrls.push(urlStr);
      if (urlStr.endsWith('/api/upload')) {
        const body = init?.body as FormData;
        if (body && typeof body.forEach === 'function') {
          body.forEach((value, key) => {
            uploadedFormDataEntries.push([key, value]);
          });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (urlStr.includes('/api/libraries/') && urlStr.endsWith('/scan')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (urlStr.includes('/api/items/')) {
        return new Response(
          JSON.stringify({
            media: { tags: [] },
          }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });
  });

  test('Guardrail: When matched candidate has an existing eBook (hasEbook: true), companion upload is omitted and triggers targeted item scan', async () => {
    // Audiobookshelf search returns an existing book that already has an eBook
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      fetchedUrls.push(urlStr);
      if (urlStr.includes('/api/libraries/lib-1/search')) {
        return new Response(
          JSON.stringify({
            book: [
              {
                id: 'abs-item-123',
                title: 'The Way of Kings',
                author: 'Brandon Sanderson',
                relPath: 'Brandon Sanderson/The Way of Kings',
                media: {
                  ebookFile: { ino: '1', filename: 'The Way of Kings.epub' },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (urlStr.endsWith('/api/upload')) {
        const body = init?.body as FormData;
        body.forEach((value, key) => {
          uploadedFormDataEntries.push([key, value]);
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (urlStr.includes('/api/items/abs-item-123')) {
        return new Response(
          JSON.stringify({
            media: { tags: [], ebookFile: { ino: '1' } },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const result = await uploadBookToAudiobookshelf({
      bookId: 'book-1',
      userId: 'user-1',
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      includeCompanionDocument: true,
      smartMatchExistingBook: true,
    });

    expect(result.success).toBe(true);
    expect(result.unified).toBe(true);
    expect(result.matchedItemId).toBe('abs-item-123');

    // compileDocumentToEpub must NOT be called
    expect(mocks.compileDocumentToEpub).not.toHaveBeenCalled();

    // FormData must contain audio file, but NOT file_companion
    const hasAudio = uploadedFormDataEntries.some(([key]) => key === 'file');
    const hasCompanion = uploadedFormDataEntries.some(([key]) => key === 'file_companion');

    expect(hasAudio).toBe(true);
    expect(hasCompanion).toBe(false);

    // Returned files list must not list companion
    expect(result.files).toContain('The Way of Kings.m4b');
    expect(result.files.some((f) => f.endsWith('.epub') || f.endsWith('.pdf'))).toBe(false);

    // Targeted item-level scan must be triggered on the matched item
    expect(fetchedUrls).toContain('http://abs.test:13378/api/items/abs-item-123/scan');
  });

  test('Publication-Grade EPUB: When no eBook exists in Audiobookshelf, compiles and attaches reflowable .epub companion and triggers library scan', async () => {
    // Audiobookshelf search returns empty or candidate without eBook
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      fetchedUrls.push(urlStr);
      if (urlStr.includes('/api/libraries/lib-1/search')) {
        return new Response(JSON.stringify({ book: [] }), { status: 200 });
      }
      if (urlStr.endsWith('/api/upload')) {
        const body = init?.body as FormData;
        body.forEach((value, key) => {
          uploadedFormDataEntries.push([key, value]);
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    const result = await uploadBookToAudiobookshelf({
      bookId: 'book-1',
      userId: 'user-1',
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      includeCompanionDocument: true,
    });

    expect(result.success).toBe(true);
    expect(mocks.compileDocumentToEpub).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 'book-1',
        userId: 'user-1',
        title: 'The Way of Kings',
        author: 'Brandon Sanderson',
      }),
    );

    const hasAudio = uploadedFormDataEntries.some(([key]) => key === 'file');
    const companionEntry = uploadedFormDataEntries.find(([key]) => key === 'file_companion');

    expect(hasAudio).toBe(true);
    expect(companionEntry).toBeDefined();

    const companionBlob = companionEntry?.[1] as Blob;
    expect(companionBlob.type).toBe('application/epub+zip');

    expect(result.files).toContain('The Way of Kings.epub');

    // Full library scan must be triggered for new book
    expect(fetchedUrls).toContain('http://abs.test:13378/api/libraries/lib-1/scan');
  });

  test('Original EPUB: When original document is already .epub, uploads directly without compilation', async () => {
    mocks.dbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
          then: (resolve: any) =>
            resolve([
              {
                id: 'book-1',
                userId: 'user-1',
                title: 'The Way of Kings',
                author: 'Brandon Sanderson',
                name: 'The Way of Kings.epub',
                type: 'epub',
              },
            ]),
        }),
      }),
    }));

    mocks.getDocumentBlob.mockResolvedValue(Buffer.from('PK\x03\x04 original epub bytes'));

    const result = await uploadBookToAudiobookshelf({
      bookId: 'book-1',
      userId: 'user-1',
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      includeCompanionDocument: true,
    });

    expect(result.success).toBe(true);
    // Should NOT call compileDocumentToEpub since source is already EPUB
    expect(mocks.compileDocumentToEpub).not.toHaveBeenCalled();
    expect(mocks.getDocumentBlob).toHaveBeenCalledWith('book-1', null);

    const companionEntry = uploadedFormDataEntries.find(([key]) => key === 'file_companion');
    expect(companionEntry).toBeDefined();
    expect((companionEntry?.[1] as Blob).type).toBe('application/epub+zip');
    expect(result.files).toContain('The Way of Kings.epub');
  });

  test('Graceful Fallback: When EPUB compilation fails, falls back to original document blob', async () => {
    mocks.compileDocumentToEpub.mockRejectedValueOnce(new Error('Pandoc binary not found'));

    const result = await uploadBookToAudiobookshelf({
      bookId: 'book-1',
      userId: 'user-1',
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      includeCompanionDocument: true,
    });

    expect(result.success).toBe(true);
    // Verified fallback to original PDF blob
    expect(mocks.getDocumentBlob).toHaveBeenCalledWith('book-1', null);

    const companionEntry = uploadedFormDataEntries.find(([key]) => key === 'file_companion');
    expect(companionEntry).toBeDefined();
    expect((companionEntry?.[1] as Blob).type).toBe('application/pdf');
    expect(result.files).toContain('The Way of Kings.pdf');
  });
});
