import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  sanitizeFilenameForAudiobookshelf,
  resolveAudiobookshelfConfig,
  fetchAudiobookshelfLibraries,
  triggerAudiobookshelfScan,
  sanitizeSearchTitle,
  buildAudiobookshelfSearchQueries,
  searchAudiobookshelfCandidates,
  matchCandidatesDeterministically,
  matchAudiobookshelfCandidateWithGemini,
  tagAudiobookshelfItem,
  type AudiobookshelfSearchCandidate,
} from '@/lib/server/audiobooks/audiobookshelf';
import { RUNTIME_CONFIG_SCHEMA } from '@/lib/server/admin/settings';

describe('Audiobookshelf Integration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('sanitizeFilenameForAudiobookshelf', () => {
    test('removes illegal filesystem characters', () => {
      const input = 'The Lord of the Rings: The Fellowship / Two Towers * "Special" <Edition>?';
      const output = sanitizeFilenameForAudiobookshelf(input);
      expect(output).toBe('The Lord of the Rings_ The Fellowship _ Two Towers _ _Special_ _Edition__');
      expect(/[\\/:*?"<>|]/.test(output)).toBe(false);
    });

    test('normalizes whitespace and removes trailing/leading periods', () => {
      const input = ' ...The   Way  of   Kings... ';
      const output = sanitizeFilenameForAudiobookshelf(input);
      expect(output).toBe('The Way of Kings');
    });

    test('falls back to "Untitled" when given empty or purely invalid string', () => {
      expect(sanitizeFilenameForAudiobookshelf('')).toBe('Untitled');
      expect(sanitizeFilenameForAudiobookshelf('...')).toBe('Untitled');
      expect(sanitizeFilenameForAudiobookshelf('   ')).toBe('Untitled');
    });
  });

  describe('resolveAudiobookshelfConfig', () => {
    test('resolves config from environment variables when present', async () => {
      process.env.AUDIOBOOKSHELF_URL = 'http://192.168.90.244:13378/';
      process.env.AUDIOBOOKSHELF_TOKEN = 'abs-secret-token-123';
      process.env.AUDIOBOOKSHELF_LIBRARY_ID = 'lib-456';
      process.env.AUDIOBOOKSHELF_FOLDER_ID = 'fold-789';

      const config = await resolveAudiobookshelfConfig();
      expect(config.url).toBe('http://192.168.90.244:13378');
      expect(config.token).toBe('abs-secret-token-123');
      expect(config.libraryId).toBe('lib-456');
      expect(config.folderId).toBe('fold-789');
      expect(config.isConfigured).toBe(true);
      expect(config.autoDetectMetadata).toBe(true);
    });

    test('detects not configured when token is missing', async () => {
      delete process.env.AUDIOBOOKSHELF_TOKEN;
      const config = await resolveAudiobookshelfConfig();
      expect(config.isConfigured).toBe(false);
    });
  });

  describe('fetchAudiobookshelfLibraries', () => {
    test('fetches and normalizes libraries list from Audiobookshelf API', async () => {
      const mockLibraries = [
        {
          id: 'lib-audiobooks',
          name: 'Audiobooks Only',
          mediaType: 'book',
          folders: [
            { id: 'folder-1', fullPath: '/mnt/truenas/Audiobooks Only' },
          ],
        },
      ];

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ libraries: mockLibraries }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const result = await fetchAudiobookshelfLibraries('http://192.168.90.244:13378', 'test-token');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('lib-audiobooks');
      expect(result[0].name).toBe('Audiobooks Only');
      expect(result[0].folders[0].id).toBe('folder-1');
      expect(result[0].folders[0].fullPath).toBe('/mnt/truenas/Audiobooks Only');
    });

    test('throws error if Audiobookshelf responds with error status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Unauthorized token', { status: 401 }),
      );

      await expect(
        fetchAudiobookshelfLibraries('http://192.168.90.244:13378', 'bad-token'),
      ).rejects.toThrow(/401/);
    });
  });

  describe('triggerAudiobookshelfScan', () => {
    test('posts to /api/libraries/:id/scan', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

      const success = await triggerAudiobookshelfScan('http://192.168.90.244:13378', 'token-123', 'lib-abc');
      expect(success).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://192.168.90.244:13378/api/libraries/lib-abc/scan',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer token-123' },
        }),
      );
    });
  });

  describe('Search Query Sanitization & Generation', () => {
    test('strips extensions, OCR and copy noise, ASIN brackets, and stray punctuation', () => {
      const raw = 'Constructing the Human: A Primer (OCR Copy) [B00123XYZ].pdf';
      const cleaned = sanitizeSearchTitle(raw);
      expect(cleaned).toBe('Constructing the Human: A Primer');
    });

    test('builds full title, subtitle-split, and author queries without duplicates', () => {
      const title = 'Adoption as Sons of God: An Exegetical Investigation [B0123].epub';
      const author = 'Trevor J. Burke';
      const queries = buildAudiobookshelfSearchQueries(title, author);

      expect(queries).toContain('Adoption as Sons of God: An Exegetical Investigation');
      expect(queries).toContain('Adoption as Sons of God');
      expect(queries).toContain('Trevor J. Burke');
    });

    test('skips author query if author is generic or Unknown', () => {
      const queries = buildAudiobookshelfSearchQueries('Simple Book Title.m4b', 'Unknown Author');
      expect(queries).toEqual(['Simple Book Title']);
    });
  });

  describe('searchAudiobookshelfCandidates', () => {
    test('queries Audiobookshelf search API, de-duplicates items, and normalizes candidate metadata', async () => {
      const mockSearchResponse = {
        book: [
          {
            libraryItem: {
              id: 'abs-item-1',
              relPath: 'Adoption as Sons of God',
              media: {
                metadata: {
                  title: 'Adoption as Sons of God',
                  authorName: 'Trevor J. Burke',
                },
                ebookFile: { id: 'ebook-1', format: 'epub' },
                audioFiles: [],
              },
            },
          },
          {
            libraryItem: {
              id: 'abs-item-1', // duplicate
              relPath: 'Adoption as Sons of God',
              media: { metadata: { title: 'Adoption as Sons of God' } },
            },
          },
          {
            id: 'abs-item-2', // direct item format
            relPath: 'Authors/Other Author/Another Book',
            media: {
              metadata: { title: 'Another Book', author: 'Other Author' },
              audioFiles: [{ id: 'audio-1' }],
            },
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify(mockSearchResponse), { status: 200 }),
      );

      const candidates = await searchAudiobookshelfCandidates(
        'http://192.168.90.244:13378',
        'token-123',
        'lib-1',
        'Adoption as Sons of God: An Exegetical Study.pdf',
        'Trevor J. Burke',
      );

      expect(candidates).toHaveLength(2);
      expect(candidates[0].id).toBe('abs-item-1');
      expect(candidates[0].title).toBe('Adoption as Sons of God');
      expect(candidates[0].author).toBe('Trevor J. Burke');
      expect(candidates[0].folderName).toBe('Adoption as Sons of God');
      expect(candidates[0].hasEbook).toBe(true);
      expect(candidates[0].hasAudio).toBe(false);

      expect(candidates[1].id).toBe('abs-item-2');
      expect(candidates[1].folderName).toBe('Another Book');
      expect(candidates[1].hasAudio).toBe(true);
      expect(candidates[1].hasEbook).toBe(false);
    });
  });

  describe('Deterministic Fallback Matching', () => {
    const candidates: AudiobookshelfSearchCandidate[] = [
      {
        id: 'item-ebook',
        title: 'Adoption as Sons of God: An Exegetical Investigation',
        author: 'Trevor J. Burke',
        folderName: 'Adoption as Sons of God',
        hasAudio: false,
        hasEbook: true,
      },
      {
        id: 'item-unrelated',
        title: 'Constructing the Human Body',
        author: 'Jane Doe',
        folderName: 'Constructing the Human Body',
        hasAudio: true,
        hasEbook: false,
      },
    ];

    test('matches candidate with high token overlap and boosts confidence for hasEbook', () => {
      const result = matchCandidatesDeterministically(
        candidates,
        'Adoption as Sons of God: An Exegetical Investigation (Paperless Scan).pdf',
        'Trevor J. Burke',
      );

      expect(result.isMatch).toBe(true);
      expect(result.matchedItemId).toBe('item-ebook');
      expect(result.matchedFolderName).toBe('Adoption as Sons of God');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    test('rejects candidate if token overlap is low (< 0.75 confidence)', () => {
      const result = matchCandidatesDeterministically(
        candidates,
        'The Great Gatsby',
        'F. Scott Fitzgerald',
      );

      expect(result.isMatch).toBe(false);
      expect(result.matchedItemId).toBeNull();
      expect(result.matchedFolderName).toBeNull();
      expect(result.confidence).toBeLessThan(0.75);
    });
  });

  describe('Gemini AI Candidate Matching', () => {
    const candidates: AudiobookshelfSearchCandidate[] = [
      {
        id: 'item-target',
        title: 'Adoption as Sons of God',
        author: 'Trevor J. Burke',
        folderName: 'Adoption as Sons of God',
        hasAudio: false,
        hasEbook: true,
      },
    ];

    test('parses structured JSON and confirms match when confidence >= 0.75', async () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    is_match: true,
                    matched_item_id: 'item-target',
                    matched_folder_name: 'Adoption as Sons of God',
                    confidence: 0.94,
                    reasoning: 'Title and author directly match existing item with eBook.',
                  }),
                },
              ],
            },
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(geminiResponse), { status: 200 }),
      );

      const result = await matchAudiobookshelfCandidateWithGemini(
        candidates,
        'Adoption as Sons of God (Audiobook edition)',
        'Trevor J. Burke',
        { primaryApiKey: 'fake-gemini-key', model: 'gemini-3.1-flash-lite' },
      );

      expect(result.isMatch).toBe(true);
      expect(result.matchedItemId).toBe('item-target');
      expect(result.matchedFolderName).toBe('Adoption as Sons of God');
      expect(result.confidence).toBe(0.94);
      expect(result.reasoning).toContain('Title and author directly match');
    });

    test('rejects match when Gemini confidence is below 0.75 threshold', async () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    is_match: true,
                    matched_item_id: 'item-target',
                    matched_folder_name: 'Adoption as Sons of God',
                    confidence: 0.60, // Below 0.75 threshold
                    reasoning: 'Uncertain match.',
                  }),
                },
              ],
            },
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(geminiResponse), { status: 200 }),
      );

      const result = await matchAudiobookshelfCandidateWithGemini(
        candidates,
        'Some Completely Different Book',
        'Different Author',
        { primaryApiKey: 'fake-gemini-key' },
      );

      expect(result.isMatch).toBe(false);
      expect(result.matchedItemId).toBeNull();
      expect(result.matchedFolderName).toBeNull();
    });

    test('falls back gracefully to deterministic matching when Gemini API errors', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      const result = await matchAudiobookshelfCandidateWithGemini(
        candidates,
        'Adoption as Sons of God',
        'Trevor J. Burke',
        { primaryApiKey: 'fake-gemini-key' },
      );

      // Deterministic matcher succeeds on title/author overlap
      expect(result.isMatch).toBe(true);
      expect(result.matchedItemId).toBe('item-target');
      expect(result.matchedFolderName).toBe('Adoption as Sons of God');
    });
  });

  describe('tagAudiobookshelfItem', () => {
    test('merges existing tags with Audiobook, Companion Audiobook, and OpenReader tags', async () => {
      let patchedBody: any = null;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const urlStr = String(url);
        const method = init?.method?.toUpperCase() || 'GET';
        if (urlStr.endsWith('/api/items/item-123') && method === 'GET') {
          return new Response(
            JSON.stringify({
              media: { tags: ['Non-Fiction', 'Theology'] },
            }),
            { status: 200 },
          );
        }
        if (urlStr.endsWith('/api/items/item-123/media') && method === 'PATCH') {
          patchedBody = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return new Response('Not found', { status: 404 });
      });

      const success = await tagAudiobookshelfItem(
        'http://192.168.90.244:13378',
        'token-123',
        'item-123',
      );

      expect(success).toBe(true);
      expect(patchedBody).not.toBeNull();
      expect(patchedBody.tags).toContain('Non-Fiction');
      expect(patchedBody.tags).toContain('Theology');
      expect(patchedBody.tags).toContain('Audiobook');
      expect(patchedBody.tags).toContain('Companion Audiobook');
      expect(patchedBody.tags).toContain('OpenReader');
    });
  });

  describe('Runtime config schema', () => {
    test('contains all Audiobookshelf and Gemini universal keys with appropriate defaults', () => {
      expect(RUNTIME_CONFIG_SCHEMA).toHaveProperty('audiobookshelfUrl');
      expect(RUNTIME_CONFIG_SCHEMA).toHaveProperty('audiobookshelfToken');
      expect(RUNTIME_CONFIG_SCHEMA).toHaveProperty('audiobookshelfLibraryId');
      expect(RUNTIME_CONFIG_SCHEMA).toHaveProperty('audiobookshelfFolderId');
      expect(RUNTIME_CONFIG_SCHEMA).toHaveProperty('audiobookshelfAutoDetectMetadata');
      expect(RUNTIME_CONFIG_SCHEMA).toHaveProperty('geminiApiKey');

      expect(RUNTIME_CONFIG_SCHEMA.audiobookshelfUrl.default).toBe('http://192.168.90.244:13378');
      expect(RUNTIME_CONFIG_SCHEMA.audiobookshelfAutoDetectMetadata.default).toBe(true);
    });
  });

  describe('Metadata inference parsing', () => {
    test('extracts title, author, and series from formatted or markdown wrapped JSON', () => {
      const rawGeminiResponse = '```json\n{\n  "title": "The Way of Kings",\n  "author": "Brandon Sanderson",\n  "series": "The Stormlight Archive",\n  "seriesIndex": "1",\n  "subtitle": null\n}\n```';
      const cleaned = rawGeminiResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      expect(parsed.title).toBe('The Way of Kings');
      expect(parsed.author).toBe('Brandon Sanderson');
      expect(parsed.series).toBe('The Stormlight Archive');
      expect(parsed.seriesIndex).toBe('1');
    });

    test('companion document retains matching basename with audio file', () => {
      const cleanTitle = sanitizeFilenameForAudiobookshelf('The Way of Kings: Special Edition');
      const audioFileName = `${cleanTitle}.m4b`;
      const companionFileName = `${cleanTitle}.pdf`;

      expect(audioFileName).toBe('The Way of Kings_ Special Edition.m4b');
      expect(companionFileName).toBe('The Way of Kings_ Special Edition.pdf');
      expect(audioFileName.replace(/\.m4b$/, '')).toBe(companionFileName.replace(/\.pdf$/, ''));
    });
  });
});
