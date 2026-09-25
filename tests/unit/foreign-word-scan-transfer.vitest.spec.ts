import { describe, expect, it } from 'vitest';
import {
  exportForeignWordScan,
  exportForeignWordScanBatches,
  generateForeignWordAiInstructions,
  parseForeignWordScanImport,
  parseForeignWordScanImportDetailed,
} from '@/lib/shared/foreign-word-scan-transfer';

const documentId = 'book-1';
const rows = [
  { word: 'λόγος', count: 12, contexts: ['The λόγος was spoken.'], libraryPronunciation: '/loʊɡɒs/', definition: 'word' },
  { word: 'θεός', count: 4, contexts: ['The θεός appeared.'], definition: null },
];

describe('foreign-word scan JSON transfer', () => {
  it('exports every word with context and empty proposal fields', () => {
    const exported = exportForeignWordScan(documentId, rows);
    expect(exported).toMatchObject({ format: 'openreader-foreign-word-scan', version: 2, documentId });
    expect(exported.words).toHaveLength(2);
    expect(exported.words[0]).toMatchObject({ word: 'λόγος', count: 12, currentDefinition: 'word', proposedPronunciation: null });
  });

  it('accepts targeted pronunciation and definition edits without changing untouched words', () => {
    const exported = exportForeignWordScan(documentId, rows);
    exported.words[0].proposedPronunciation = '/loʊɡos/';
    exported.words[0].proposedDefinition = 'divine word';
    expect(parseForeignWordScanImport(exported, documentId, new Set(rows.map((row) => row.word)))).toEqual([
      { word: 'λόγος', pronunciation: '/loʊɡos/', definition: 'divine word' },
    ]);
  });

  it('accepts transliterated words with Unicode modifier half-rings like hāʾādām', () => {
    const transliteratedRows = [
      { word: 'hāʾādām', count: 5, contexts: ['The hāʾādām walked.'], definition: null },
    ];
    const exported = exportForeignWordScan(documentId, transliteratedRows);
    exported.words[0].proposedPronunciation = '/hɑɑdɑm/';
    exported.words[0].proposedDefinition = 'the human';
    expect(parseForeignWordScanImport(exported, documentId, new Set(['hāʾādām']))).toEqual([
      { word: 'hāʾādām', pronunciation: '/hɑɑdɑm/', definition: 'the human' },
    ]);
  });

  it('rejects a different book, invented words, duplicates, and invalid pronunciations', () => {
    const exported = exportForeignWordScan(documentId, rows);
    exported.words[0].proposedPronunciation = '/loʊɡos/';
    expect(() => parseForeignWordScanImport(exported, 'book-2', new Set(rows.map((row) => row.word)))).toThrow(/different document/);
    exported.words[0].word = 'invented';
    expect(() => parseForeignWordScanImport(exported, documentId, new Set(rows.map((row) => row.word)))).toThrow(/Unknown/);
    exported.words[0].word = 'λόγος';
    exported.words.push({ ...exported.words[0] });
    expect(() => parseForeignWordScanImport(exported, documentId, new Set(rows.map((row) => row.word)))).toThrow(/duplicate/);
    exported.words.pop();
    exported.words[0].proposedPronunciation = 'not IPA';
    expect(() => parseForeignWordScanImport(exported, documentId, new Set(rows.map((row) => row.word)))).toThrow(/Invalid Kokoro/);
  });

  it('skips invalid words and collects review diagnostics when allowPartial is true', () => {
    const exported = exportForeignWordScan(documentId, [
      { word: 'λόγος', count: 12, contexts: ['The λόγος was spoken.'], libraryPronunciation: '/loʊɡɒs/', definition: 'word' },
      { word: 'θεός', count: 4, contexts: ['The θεός appeared.'], definition: null },
    ]);
    exported.words[0].proposedPronunciation = '/loʊɡos/';
    exported.words[0].proposedDefinition = 'divine word';
    exported.words[1].proposedPronunciation = 'not IPA';

    // Strict mode throws
    expect(() => parseForeignWordScanImport(exported, documentId, new Set(['λόγος', 'θεός']))).toThrow(/Invalid Kokoro/);

    // Detailed partial mode imports the valid word and returns the skipped invalid word
    const result = parseForeignWordScanImportDetailed(exported, documentId, new Set(['λόγος', 'θεός']), new Map(), { allowPartial: true });
    expect(result.changes).toEqual([
      { word: 'λόγος', pronunciation: '/loʊɡos/', definition: 'divine word' },
    ]);
    expect(result.skipped).toEqual([
      { word: 'θεός', reason: 'Invalid Kokoro pronunciation for θεός.' },
    ]);
  });

  it('requires an explicit omission switch to clear a definition', () => {
    const exported = exportForeignWordScan(documentId, rows);
    exported.words[0].omitDefinition = true;
    expect(parseForeignWordScanImport(exported, documentId, new Set(rows.map((row) => row.word)))).toEqual([
      { word: 'λόγος', definition: null },
    ]);
  });

  it('preserves source evidence in v2 while accepting legacy v1 edit semantics', () => {
    const evidence = exportForeignWordScan(documentId, [{
      ...rows[0], sourceStatus: 'needs_source_repair', qualityFlags: ['detached_combining_mark'],
      editorialSpellings: ['θε(οῦ)'], ocrEvidence: ['damaged token'],
      occurrences: [{ pdfPage: 179, surfaceTerm: 'λόγος', context: 'The λόγος appears.',
        sourceStart: 1500, sourceEnd: 1505, pageSourceStart: 120, pageSourceEnd: 125,
        contextTargetStart: 4, contextTargetEnd: 9, qualityFlags: ['detached_combining_mark'] }],
    }]);
    expect(evidence.words[0]).toMatchObject({
      sourceStatus: 'needs_source_repair', qualityFlags: ['detached_combining_mark'],
      occurrences: [{ pdfPage: 179, sourceStart: 1500, pageSourceStart: 120, contextTargetStart: 4 }],
    });
    evidence.words[0].proposedDefinition = 'spoken word';
    expect(() => parseForeignWordScanImport(evidence, documentId, new Set(['λόγος']), new Map([
      ['λόγος', 'needs_source_repair'],
    ]))).toThrow(/PDF source repair/);
    expect(parseForeignWordScanImport(evidence, documentId, new Set(['λόγος']))).toEqual([
      { word: 'λόγος', definition: 'spoken word' },
    ]);
    const legacy = { ...evidence, version: 1 };
    expect(parseForeignWordScanImport(legacy, documentId, new Set(['λόγος']))).toHaveLength(1);
  });

  it('splits large scans into numbered batch files with optional compact AI format', () => {
    const manyRows = Array.from({ length: 25 }, (_, i) => {
      const letter = String.fromCharCode(97 + i);
      const word = `word${letter}`;
      return {
        word,
        count: 1,
        contexts: [`Context for ${word}`],
        occurrences: [{
          pdfPage: 10 + i,
          surfaceTerm: word,
          normalizedTerm: word,
          sourceStart: 100,
          sourceEnd: 105,
          pageSourceStart: 10,
          pageSourceEnd: 15,
          blockId: 'b1',
          bbox: [10, 20, 30, 40],
          coordinateSource: 'fitz',
          context: `Context for ${word}`,
          contextTargetStart: 12,
          contextTargetEnd: 17,
          extractionMethod: 'primary',
          qualityFlags: [],
          qualityEvidence: [],
          sourceStatus: 'unverified',
        }],
      };
    });

    const batches = exportForeignWordScanBatches(documentId, manyRows, { batchSize: 10, compactForAi: true });
    expect(batches).toHaveLength(3);

    // Part 1: 10 words
    expect(batches[0].filename).toBe('foreign-words-book-1-part-01.json');
    expect(batches[0].partIndex).toBe(1);
    expect(batches[0].totalParts).toBe(3);
    expect(batches[0].wordCount).toBe(10);
    expect(batches[0].payload.words).toHaveLength(10);
    expect(batches[0].payload.instructions).toContain('Batch 1 of 3 (10 words)');
    expect(batches[0].payload.instructions).toContain('Compact AI prompt format');

    // Verify compact AI occurrence strips internal coordinate bloat
    const firstOcc = batches[0].payload.words[0].occurrences[0];
    expect(firstOcc).toHaveProperty('surfaceTerm', 'worda');
    expect(firstOcc).toHaveProperty('pdfPage', 10);
    expect(firstOcc).toHaveProperty('context', 'Context for worda');
    expect(firstOcc).not.toHaveProperty('bbox');
    expect(firstOcc).not.toHaveProperty('blockId');
    expect(firstOcc).not.toHaveProperty('sourceStart');
    expect(firstOcc).not.toHaveProperty('pageSourceStart');

    // Part 3: remaining 5 words
    expect(batches[2].filename).toBe('foreign-words-book-1-part-03.json');
    expect(batches[2].partIndex).toBe(3);
    expect(batches[2].wordCount).toBe(5);

    // Editing part 1 and importing it works seamlessly
    batches[0].payload.words[0].proposedPronunciation = '/wɜːrd/';
    const allowed = new Set(manyRows.map((r) => r.word));
    const changes = parseForeignWordScanImport(batches[0].payload, documentId, allowed);
    expect(changes).toEqual([{ word: 'worda', pronunciation: '/wɜːrd/' }]);
  });

  it('generates comprehensive markdown AI instructions covering Kokoro phonetics and stop-words', () => {
    const guide = generateForeignWordAiInstructions({ documentId: 'book-1', totalWords: 150 });
    expect(guide).toContain('# OpenReader AI Agent Guide: Processing Foreign Word Scans');
    expect(guide).toContain('book-1');
    expect(guide).toContain('150 words');
    expect(guide).toContain('proposedPronunciation');
    expect(guide).toContain('proposedDefinition');
    expect(guide).toContain('omitDefinition');
    expect(guide).toContain('Kokoro Pronunciation Guidelines');
    expect(guide).toContain('NO Grammatical Stop-Words');
    expect(guide).toContain('הוּא');

    const flaggedGuide = generateForeignWordAiInstructions({ documentId: 'book-1', totalWords: 25, isFlaggedExport: true });
    expect(flaggedGuide).toContain('Handling Flagged Words');
    expect(flaggedGuide).toContain('Invalid contextual definition');
    expect(flaggedGuide).toContain('Invalid Kokoro pronunciation');
  });

  it('normalizes malformed pronunciations on import (spaced phonemes, missing slashes, markdown links)', () => {
    const documentId = 'doc-1';
    const words = [
      {
        word: 'hāʾādām',
        proposedPronunciation: '/hɑː dɑːm/', // Spaced phonemes
        proposedDefinition: null,
      },
      {
        word: 'בהמה',
        proposedPronunciation: 'bəheɪmɑː', // Missing slashes
        proposedDefinition: null,
      },
      {
        word: 'λόγος',
        proposedPronunciation: '[λόγος](/loʊɡɒs/])', // Markdown tag and typo
        proposedDefinition: null,
      },
    ];
    const allowed = new Set(['hāʾādām', 'בהמה', 'λόγος']);
    const result = parseForeignWordScanImportDetailed({
      format: 'openreader-foreign-word-scan',
      version: 2,
      documentId,
      words,
    }, documentId, allowed);

    expect(result.skipped).toEqual([]);
    expect(result.changes).toEqual([
      { word: 'hāʾādām', pronunciation: '/hɑːdɑːm/' },
      { word: 'בהמה', pronunciation: '/bəheɪmɑː/' },
      { word: 'λόγος', pronunciation: '/loʊɡɒs/' },
    ]);
  });

  it('automatically omits stop-words and function-word-only glosses on import without failing', () => {
    const documentId = 'doc-1';
    const words = [
      {
        word: 'הוּא',
        proposedPronunciation: '/hu/',
        proposedDefinition: 'he', // Function word / stop word
      },
      {
        word: 'בָּהֶם',
        proposedPronunciation: '/bɑhɛm/',
        proposedDefinition: 'in them', // Function words
      },
      {
        word: 'מִן',
        proposedPronunciation: '/mɪn/',
        proposedDefinition: 'from', // Preposition stop word
      },
      {
        word: 'שלום',
        proposedPronunciation: '/ʃəloʊm/',
        proposedDefinition: 'peace', // Valid content word definition
      },
    ];
    const allowed = new Set(['הוּא', 'בָּהֶם', 'מִן', 'שלום']);
    const result = parseForeignWordScanImportDetailed({
      format: 'openreader-foreign-word-scan',
      version: 2,
      documentId,
      words,
    }, documentId, allowed);


    expect(result.skipped).toEqual([]);
    expect(result.changes).toEqual([
      { word: 'הוּא', pronunciation: '/hu/', definition: null },
      { word: 'בָּהֶם', pronunciation: '/bɑhɛm/', definition: null },
      { word: 'מִן', pronunciation: '/mɪn/', definition: null },
      { word: 'שלום', pronunciation: '/ʃəloʊm/', definition: 'peace' },
    ]);
  });
});
