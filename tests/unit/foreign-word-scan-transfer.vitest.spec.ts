import { describe, expect, it } from 'vitest';
import { exportForeignWordScan, parseForeignWordScanImport } from '@/lib/shared/foreign-word-scan-transfer';

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
});
