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
  checkAudiobookshelfItemHasEbook,
  type AudiobookshelfSearchCandidate,
} from '@/lib/server/audiobooks/audiobookshelf';
import {
  clean_tex,
  clean_block_text,
  clean_toc_text,
  stitch_paragraphs,
  placeFootnoteInText,
  cleanChapterTextForEpub,
  buildEpubMarkdown,
} from '@/lib/server/audiobooks/epub-generator';
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
      expect(patchedBody.tags).toContain('Companion eBook');
      expect(patchedBody.tags).toContain('EPUB');
      expect(patchedBody.tags).toContain('OpenReader');
    });
  });

  describe('checkAudiobookshelfItemHasEbook', () => {
    test('returns true when media.ebookFile is present', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            media: {
              ebookFile: { ino: '1', filename: 'book.epub' },
            },
          }),
          { status: 200 },
        ),
      );

      const result = await checkAudiobookshelfItemHasEbook(
        'http://abs.test:13378',
        'token-123',
        'item-with-ebook',
      );
      expect(result).toBe(true);
    });

    test('returns true when media.ebookFiles contains entries', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            media: {
              ebookFiles: [{ ino: '1', filename: 'book.pdf' }],
            },
          }),
          { status: 200 },
        ),
      );

      const result = await checkAudiobookshelfItemHasEbook(
        'http://abs.test:13378',
        'token-123',
        'item-with-ebook-array',
      );
      expect(result).toBe(true);
    });

    test('returns true when media.hasEbook flag is true', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            media: {
              hasEbook: true,
            },
          }),
          { status: 200 },
        ),
      );

      const result = await checkAudiobookshelfItemHasEbook(
        'http://abs.test:13378',
        'token-123',
        'item-flagged-ebook',
      );
      expect(result).toBe(true);
    });

    test('returns false when no ebook is associated with the item', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            media: {
              audioFiles: [{ ino: '2', filename: 'audio.m4b' }],
              numTracks: 1,
            },
          }),
          { status: 200 },
        ),
      );

      const result = await checkAudiobookshelfItemHasEbook(
        'http://abs.test:13378',
        'token-123',
        'item-audio-only',
      );
      expect(result).toBe(false);
    });

    test('returns false when the API request errors', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const result = await checkAudiobookshelfItemHasEbook(
        'http://abs.test:13378',
        'token-123',
        'item-error',
      );
      expect(result).toBe(false);
    });
  });

  describe('EPUB Text & Markdown Pipeline', () => {
    describe('1. TeX Sanitization (clean_tex)', () => {
      test('converts Greek TeX symbols, unwraps macros, and strips OCR noise', () => {
        const raw = 'The symbol \\Sigma and \\Theta with \\Delta form \\widetilde{ KA\\Theta\\Upsilon } and \\dots';
        const cleaned = clean_tex(raw);
        expect(cleaned).toContain('Σ');
        expect(cleaned).toContain('Θ');
        expect(cleaned).toContain('Δ');
        expect(cleaned).toContain('KAΘΥ');
        expect(cleaned).toContain('...');
        expect(cleaned).not.toContain('\\widetilde');
      });

      test('strips dangling unclosed macro prefixes caused by OCR noise', () => {
        const raw = 'Text with dangling \\widetilde{ KA\\Theta\\Upsilon without closing brace';
        const cleaned = clean_tex(raw);
        expect(cleaned).toBe('Text with dangling  KAΘΥ without closing brace');
        expect(cleaned).not.toContain('\\widetilde');
      });
    });

    describe('2. Intra-Block Line Reflow & Hyphen Healing (clean_block_text)', () => {
      test('joins lines with single space and heals line-end hyphens', () => {
        const block = [
          'Paul argues in his epistle that',
          'the believers are granted full',
          'adop-',
          'tion according to law.',
        ].join('\n');

        const cleaned = clean_block_text(block);
        expect(cleaned).toBe('Paul argues in his epistle that the believers are granted full adoption according to law.');
      });

      test('heals remaining cross-line word hyphens and Greek script', () => {
        const block = 'The doctrine of υἱοθε-\nσία is central.';
        const cleaned = clean_block_text(block);
        expect(cleaned).toBe('The doctrine of υἱοθεσία is central.');
      });
    });

    describe('3. Preserving Table of Contents & Chapter Lists (clean_toc_text)', () => {
      test('formats TOC entries with Markdown hard line breaks (two spaces + newline)', () => {
        const tocRaw = [
          'Chapter 1: The Meaning of Adoption . . . 15',
          'Chapter 2: The Roman Law of Adoption . . . 45',
          'Chapter 3: Adoption in Galatians . . . 85',
        ].join('\n');

        const cleaned = clean_toc_text(tocRaw);
        expect(cleaned).toBe(
          'Chapter 1: The Meaning of Adoption . . . 15  \nChapter 2: The Roman Law of Adoption . . . 45  \nChapter 3: Adoption in Galatians . . . 85',
        );
      });

      test('wraps subtitles within the same entry cleanly', () => {
        const tocRaw = [
          'Chapter 1: The Meaning of Adoption',
          'A Theological Analysis . . . 15',
          'Chapter 2: The Law . . . 45',
        ].join('\n');

        const cleaned = clean_toc_text(tocRaw);
        expect(cleaned).toContain('Chapter 1: The Meaning of Adoption A Theological Analysis . . . 15  \nChapter 2: The Law . . . 45');
      });
    });

    describe('4. Page-Spanning Paragraph Stitcher (stitch_paragraphs)', () => {
      test('merges mid-sentence paragraph breaks across page boundaries when no terminal punctuation', () => {
        const paragraphs = [
          { text: 'Paul argues in his epistle that' },
          { text: 'the believers are granted full sonship.' },
        ];

        const stitched = stitch_paragraphs(paragraphs);
        expect(stitched).toHaveLength(1);
        expect(stitched[0].text).toBe('Paul argues in his epistle that the believers are granted full sonship.');
      });

      test('heals line-break hyphen across page transitions', () => {
        const paragraphs = [
          { text: 'This was the Roman law of adop-' },
          { text: 'tion which governed inheritance.' },
        ];

        const stitched = stitch_paragraphs(paragraphs);
        expect(stitched).toHaveLength(1);
        expect(stitched[0].text).toBe('This was the Roman law of adoption which governed inheritance.');
      });

      test('Critical Guardrail: NEVER stitches list or TOC items into adjacent paragraphs or across pages', () => {
        const paragraphs = [
          { text: 'Chapter 1: The Meaning of Adoption . . . 15', isList: true },
          { text: 'Chapter 2: The Roman Law . . . 45', isList: true },
          { text: 'Chapter 1 begins with a discussion of terminology.' },
        ];

        const stitched = stitch_paragraphs(paragraphs);
        expect(stitched).toHaveLength(3);
        expect(stitched[0].text).toBe('Chapter 1: The Meaning of Adoption . . . 15');
        expect(stitched[1].text).toBe('Chapter 2: The Roman Law . . . 45');
        expect(stitched[2].text).toBe('Chapter 1 begins with a discussion of terminology.');
      });
    });

    describe('5. The 4-Tier Regex Footnote Placement Engine (with Verse-Collision Guard)', () => {
      test('Tier 1: replaces explicit superscript carets or braces', () => {
        const text = 'According to Hort^{12}, the text was written in Rome.';
        const result = placeFootnoteInText(text, '12', '[^c1_12]');
        expect(result.placed).toBe(true);
        expect(result.newText).toBe('According to Hort[^c1_12], the text was written in Rome.');
      });

      test('Tier 2: replaces punctuation followed by footnote number with verse-collision guard', () => {
        const text = 'This was the Roman law of adoption.12 It provided legal protection.';
        const result = placeFootnoteInText(text, '12', '[^c1_12]');
        expect(result.placed).toBe(true);
        expect(result.newText).toBe('This was the Roman law of adoption.[^c1_12] It provided legal protection.');
      });

      test('Verse-Collision Guard: Does NOT match colon-separated Bible verses (Romans 8:15)', () => {
        const text = 'See Romans 8:15 for Paul’s doctrine of adoption.';
        const result = placeFootnoteInText(text, '15', '[^c1_15]');
        // Should not match 8:15 as footnote 15
        expect(result.placed).toBe(false);
        expect(result.newText).toBe('See Romans 8:15 for Paul’s doctrine of adoption.');
      });

      test('Tier 3: replaces word immediately followed by footnote number', () => {
        const text = 'Paul discusses adoption12 in his theological work.';
        const result = placeFootnoteInText(text, '12', '[^c1_12]');
        expect(result.placed).toBe(true);
        expect(result.newText).toBe('Paul discusses adoption[^c1_12] in his theological work.');
      });

      test('Tier 4: replaces section decimal numbers', () => {
        const text = 'Section 1.2^3 outlines the Roman background.';
        const result = placeFootnoteInText(text, '3', '[^c1_3]');
        expect(result.placed).toBe(true);
        expect(result.newText).toBe('Section 1.2[^c1_3] outlines the Roman background.');
      });
    });

    describe('6. buildEpubMarkdown with Footnotes & Delimited Unplaced Fallback', () => {
      test('places footnotes, scopes keys to chapter, prevents clumping on unplaced notes, and emits definitions', () => {
        const chapters = [
          {
            title: 'Introduction',
            text: 'Paul wrote concerning adoption.12 He was writing to Gentiles. The context was Roman law.',
            footnotes: [
              { num: '12', text: 'F. J. A. Hort, *Prolegomena*, p. 111.' },
              { num: '13', text: 'Unreferenced OCR footnote citation.' },
              { num: '14', text: 'Another unreferenced citation.' },
            ],
          },
        ];

        const markdown = buildEpubMarkdown(chapters);

        // Heading
        expect(markdown).toContain('# Introduction\n\n');

        // Placed footnote in body text
        expect(markdown).toContain('adoption.[^c1_12]');

        // Delimited fallback for unplaced notes: comma-space separated (preventing clumping bug)
        expect(markdown).toContain('[^c1_13], [^c1_14]');
        expect(markdown).not.toContain('[^c1_13][^c1_14]');

        // Interactive definitions at bottom
        expect(markdown).toContain('[^c1_12]: F. J. A. Hort, *Prolegomena*, p. 111.');
        expect(markdown).toContain('[^c1_13]: Unreferenced OCR footnote citation.');
        expect(markdown).toContain('[^c1_14]: Another unreferenced citation.');
      });
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
