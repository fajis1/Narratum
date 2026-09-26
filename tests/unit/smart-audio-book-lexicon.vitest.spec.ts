import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  collectSmartAudioTermCandidates,
  enrichTextFromBookLexicon,
  isCompleteScholarScanScope,
  pronunciationsFromBookLexicon,
  selectPronunciationsForText,
} from '../../src/lib/server/smart-audio/book-lexicon';
import { mergeDocumentSettings } from '../../src/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS, type SmartAudioBookLexicon } from '../../src/types/document-settings';

const lexicon: SmartAudioBookLexicon = {
  schemaVersion: 1,
  status: 'complete',
  definitionScanComplete: true,
  profileId: 'biblical-definitions',
  pronunciationModel: 'gemini-3.6-flash',
  scannedAt: 123,
  entries: {
    λόγος: {
      term: 'λόγος',
      pronunciation: '/ˈlo.ɡos/',
      definition: 'word',
      language: 'koine_greek',
    },
  },
};

describe('Smart Audio book lexicon', () => {
  test('keeps remembered pronunciations through settings reads and rescans with no new candidate', async () => {
    const { resolveSmartAudioBookLexicon } = await import('../../src/lib/server/smart-audio/book-lexicon');
    const remembered = { ...lexicon, entries: { 'λόγος': { term: 'λόγος', pronunciation: '/lɒɡɒs/', definition: null,
      language: 'koine_greek' as const, definitionOmitted: true, approvedRepair: true } } };
    const restored = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, { smartAudioLexicon: remembered }).smartAudioLexicon!;
    expect(restored.entries['λόγος']).toMatchObject({ approvedRepair: true, definitionOmitted: true });
    const result = await resolveSmartAudioBookLexicon({ profile: { id: 'test', name: 'Test', aiModel: 'fixture', customTtsPrompt: '', abbreviations: {}, pronunciations: {}, books: {} },
      candidates: [], existing: restored });
    expect(pronunciationsFromBookLexicon(result)).toEqual({ 'λόγος': '/lɒɡɒs/' });
  });
  test('collects unique Greek and Hebrew terms with representative context', () => {
    const candidates = collectSmartAudioTermCandidates([
      'John calls Christ the λόγος who was with God. Later, λόγος appears again.',
      'The Hebrew term חֶסֶד describes covenant love.',
      'A longer quotation λόγος θεοῦ remains untouched.',
    ], { λόγος: '/ˈlo.ɡos/' });

    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        term: 'λόγος',
        pronunciation: '/ˈlo.ɡos/',
        contexts: expect.arrayContaining([expect.stringContaining('John calls Christ')]),
      }),
      expect.objectContaining({
        term: 'חֶסֶד',
        contexts: expect.arrayContaining([expect.stringContaining('covenant love')]),
      }),
    ]));
    expect(candidates.filter((candidate) => candidate.term === 'λόγος')).toHaveLength(1);
    expect(candidates.some((candidate) => candidate.term === 'θεοῦ')).toBe(false);
  });

  test('adds a cached definition once and does not re-wrap existing pronunciation markup', () => {
    expect(enrichTextFromBookLexicon(
      'The λόγος is discussed; λόγος appears again.',
      lexicon,
      { includeDefinitions: true },
    )).toBe('The [λόγος](/ˈlo.ɡos/), word, is discussed; [λόγος](/ˈlo.ɡos/) appears again.');

    expect(enrichTextFromBookLexicon(
      'The [λόγος](/ˈlo.ɡos/) is discussed.',
      lexicon,
      { includeDefinitions: true },
    )).toBe('The [λόγος](/ˈlo.ɡos/) is discussed.');

    expect(enrichTextFromBookLexicon(
      'The quotation λόγος θεοῦ stays definition-free.',
      lexicon,
      { includeDefinitions: true },
    )).toBe('The quotation [λόγος](/ˈlo.ɡos/) θεοῦ stays definition-free.');

    expect(enrichTextFromBookLexicon(
      'The λόγος, word, is central to the passage.',
      lexicon,
      { includeDefinitions: true },
    )).toBe('The [λόγος](/ˈlo.ɡos/), word, is central to the passage.');

    expect(enrichTextFromBookLexicon(
      'The Greek word λόγος appears in lawful discussion.',
      lexicon,
      { includeDefinitions: true },
    )).toBe('The Greek word [λόγος](/ˈlo.ɡos/), word, appears in lawful discussion.');

    expect(enrichTextFromBookLexicon(
      'The λόγος is discussed.',
      lexicon,
      {
        includeDefinitions: true,
        pronunciationOverrides: { λόγος: '/new-profile-ipa/' },
      },
    )).toBe('The [λόγος](/new-profile-ipa/), word, is discussed.');
  });

  test('counts an author-supplied first gloss as the one spoken definition', () => {
    expect(enrichTextFromBookLexicon(
      'The λόγος, meaning word, appears here. Later λόγος appears again.',
      lexicon,
      { includeDefinitions: true },
    )).toBe(
      'The [λόγος](/ˈlo.ɡos/), meaning word, appears here. Later [λόγος](/ˈlo.ɡos/) appears again.',
    );
  });

  test('speaks one useful gloss and suppresses connector-only definitions', () => {
    const dirtyLexicon: SmartAudioBookLexicon = {
      ...lexicon,
      entries: {
        φρονεῖν: {
          term: 'φρονεῖν',
          pronunciation: '/frɒneɪn/',
          definition: 'to think, set mind',
          language: 'koine_greek',
        },
        καί: {
          term: 'καί',
          pronunciation: '/keɪ/',
          definition: 'or',
          language: 'koine_greek',
        },
      },
    };
    expect(enrichTextFromBookLexicon(
      'The φρονεῖν appears before καί.',
      dirtyLexicon,
      { includeDefinitions: true },
    )).toBe('The [φρονεῖν](/frɒneɪn/), to think, appears before [καί](/keɪ/).');
  });

  test('does not replace a lexicon term inside a longer foreign-script word', () => {
    const prefixLexicon: SmartAudioBookLexicon = {
      ...lexicon,
      entries: {
        λόγ: {
          term: 'λόγ',
          pronunciation: '/loɡ/',
          definition: 'word root',
          language: 'koine_greek',
        },
      },
    };
    expect(enrichTextFromBookLexicon(
      'The complete word λόγος must remain intact.',
      prefixLexicon,
      { includeDefinitions: true },
    )).toBe('The complete word λόγος must remain intact.');
  });

  test('only certifies unrestricted full-corpus Scholar scans', () => {
    expect(isCompleteScholarScanScope({
      mode: 'all_foreign',
      target: 100,
    })).toBe(true);
    expect(isCompleteScholarScanScope({
      mode: 'greek_hebrew',
      target: 100,
    })).toBe(true);
    expect(isCompleteScholarScanScope({
      mode: 'all_foreign',
      target: 80,
    })).toBe(false);
    expect(isCompleteScholarScanScope({
      mode: 'custom',
      target: 100,
      query: 'λόγος',
    })).toBe(false);
  });

  test('sends only pronunciations present in the current chunk', () => {
    expect(selectPronunciationsForText('The λόγος appears.', {
      λόγος: '/ˈlo.ɡos/',
      חֶסֶד: '/ˈxe.sed/',
    })).toEqual({ λόγος: '/ˈlo.ɡos/' });
  });

  test('makes compatible per-book pronunciations available to final validation', () => {
    const compatibleLexicon = {
      ...lexicon,
      entries: {
        ...lexicon.entries,
        'λόγος': { ...lexicon.entries['λόγος'], pronunciation: '/lo.ɡos/' },
      },
    };
    expect(pronunciationsFromBookLexicon(compatibleLexicon)).toEqual({
      'λόγος': '/lo.ɡos/',
    });
  });

  test('preserves a valid per-book lexicon in document settings', () => {
    expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      smartAudioLexicon: lexicon,
    }).smartAudioLexicon).toEqual(lexicon);
  });

  test('does not treat a legacy or Standard-only lexicon as definition-complete', () => {
    const normalized = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      smartAudioLexicon: {
        ...lexicon,
        definitionScanComplete: undefined,
        entries: {},
      },
    }).smartAudioLexicon;
    expect(normalized?.status).toBe('complete');
    expect(normalized?.definitionScanComplete).toBe(false);

    const scanRoute = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/documents/scan-foreign-words/route.ts'),
      'utf8',
    );
    expect(scanRoute).toContain('needsScholarDefinition');
    expect(scanRoute).toContain('const definitionScanComplete = Boolean(');
    expect(scanRoute).toContain('Individual Gemini omissions');
    expect(scanRoute).not.toContain('const requiredDefinitionWords');
  });

  test('server-managed lexicon writes do not advance the client settings clock', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/server/smart-audio/book-lexicon.ts'),
      'utf8',
    );
    expect(source).toContain("jsonb_set(coalesce(${documentSettings.dataJson}");
    expect(source).toContain("json_set(coalesce(${documentSettings.dataJson}");
    expect(source).not.toContain('clientUpdatedAtMs: now');
    expect(source).not.toContain('clientUpdatedAtMs: mergedDataJson');
  });

  test('Scholar cleanup no longer performs a separate semantic Gemini request', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'biblical_scholar_worker.py'), 'utf8');
    expect(source).not.toContain('enrich_text_with_semantics');
    expect(source).not.toContain('LINGUISTIC_PROMPT');
    expect(source.match(/generate_content\(/g)).toHaveLength(1);
  });

  test('unscanned Scholar jobs require an explicit warning acknowledgement', () => {
    const queueRoute = fs.readFileSync(
      path.join(process.cwd(), 'src/app/api/audiobooks/queue/route.ts'),
      'utf8',
    );
    const exportModal = fs.readFileSync(
      path.join(process.cwd(), 'src/components/AudiobookExportModal.tsx'),
      'utf8',
    );
    const worker = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/server/audiobooks/worker.ts'),
      'utf8',
    );

    expect(queueRoute).toContain("code: 'SCHOLAR_SCAN_REQUIRED'");
    expect(queueRoute).toContain('!confirmScholarAutoScan');
    expect(exportModal).toContain('Pronunciation & Definition Scan Needed');
    expect(exportModal).toContain('Continue & Auto-Scan');
    expect(exportModal).toContain('confirmScholarAutoScan');
    expect(worker).toContain('resolveSmartAudioBookLexicon');
    expect(worker).toContain('scholarAutoScan !== true');
    expect(worker).toContain('audiobooks.gemini.clean');
    expect(worker).not.toContain('audiobooks.gemini.scholar');
  });

  test('explicit non-biblical classifications do not require a definition', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              items: [{
                term: 'λόγος',
                language: 'other',
                pronunciations: ['/loʊɡɒs/'],
                definition: null,
              }],
            }),
          }],
        },
      }],
    }), { status: 200 });
    try {
      const { resolveSmartAudioBookLexicon } = await import('../../src/lib/server/smart-audio/book-lexicon');
      const result = await resolveSmartAudioBookLexicon({
        profile: {
          id: 'test',
          name: 'Test',
          aiModel: 'cleanup',
          pronunciationAiModel: 'pronunciation',
          customTtsPrompt: '',
          abbreviations: {},
          pronunciations: {},
          books: {},
          geminiApiKey: 'test-only-placeholder',
        },
        candidates: [{ term: 'λόγος', contexts: ['A modern usage.'] }],
      });
      expect(result.status).toBe('complete');
      expect(result.definitionScanComplete).toBe(true);
      expect(result.entries.λόγος?.language).toBe('other');
      expect(result.entries.λόγος?.definition).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('turns Gemini form-description placeholders into intentional null definitions', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              items: [{
                term: 'κω',
                language: 'koine_greek',
                pronunciations: ['/koʊ/'],
                definition: 'Fragment or inflected form',
                definitionOmitted: false,
                needsReview: false,
              }],
            }),
          }],
        },
      }],
    }), { status: 200 });
    try {
      const { resolveSmartAudioBookLexicon } = await import('../../src/lib/server/smart-audio/book-lexicon');
      const result = await resolveSmartAudioBookLexicon({
        profile: {
          id: 'test',
          name: 'Test',
          aiModel: 'cleanup',
          pronunciationAiModel: 'pronunciation',
          customTtsPrompt: '',
          abbreviations: {},
          pronunciations: {},
          books: {},
          geminiApiKey: 'test-only-placeholder',
        },
        candidates: [{ term: 'κω', contexts: ['An OCR fragment κω appeared.'] }],
      });
      expect(result.status).toBe('complete');
      expect(result.entries.κω?.definition).toBeNull();
      expect(result.entries.κω?.definitionOmitted).toBe(true);
      expect(enrichTextFromBookLexicon('The κω appears.', result, { includeDefinitions: true }))
        .toBe('The [κω](/koʊ/) appears.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('seeds an existing global pronunciation before resolving definitions', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              items: [{
                term: 'λόγος',
                language: 'koine_greek',
                pronunciations: [],
                definition: 'word',
                definitionOmitted: false,
                needsReview: false,
              }],
            }),
          }],
        },
      }],
      }), { status: 200 });
    };
    try {
      const { resolveSmartAudioBookLexicon } = await import('../../src/lib/server/smart-audio/book-lexicon');
      const result = await resolveSmartAudioBookLexicon({
        profile: {
          id: 'test',
          name: 'Test',
          aiModel: 'cleanup',
          pronunciationAiModel: 'pronunciation',
          customTtsPrompt: '',
          abbreviations: {},
          pronunciations: {},
          books: {},
          geminiApiKey: 'test-only-placeholder',
        },
        candidates: [{
          term: 'λόγος',
          contexts: ['The λόγος means word.'],
          pronunciation: '/loʊɡɒs/',
        }],
      });
      expect(result.status).toBe('complete');
      expect(result.entries.λόγος?.pronunciation).toBe('/loʊɡɒs/');
      expect(result.entries.λόγος?.definition).toBe('word');
      expect(fetchCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does not call Gemini when global pronunciation and definition are both present', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 500 });
    };
    try {
      const { resolveSmartAudioBookLexicon } = await import('../../src/lib/server/smart-audio/book-lexicon');
      const result = await resolveSmartAudioBookLexicon({
        profile: {
          id: 'test',
          name: 'Test',
          aiModel: 'cleanup',
          pronunciationAiModel: 'pronunciation',
          customTtsPrompt: '',
          abbreviations: {},
          pronunciations: {},
          books: {},
        },
        candidates: [{
          term: 'λόγος',
          contexts: ['The λόγος means word.'],
          pronunciation: '/loʊɡɒs/',
          definition: 'word',
        }],
      });
      expect(result.status).toBe('complete');
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('preserves Gemini throttle metadata for upstream retry handling', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('rate limited', {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
    try {
      const { resolveSmartAudioBookLexicon } = await import('../../src/lib/server/smart-audio/book-lexicon');
      await expect(resolveSmartAudioBookLexicon({
        profile: {
          id: 'test',
          name: 'Test',
          aiModel: 'cleanup',
          pronunciationAiModel: 'pronunciation',
          customTtsPrompt: '',
          abbreviations: {},
          pronunciations: {},
          books: {},
          geminiApiKey: 'test-only-placeholder',
        },
        candidates: [{ term: 'λόγος', contexts: ['The λόγος appeared.'] }],
      })).rejects.toMatchObject({ status: 429 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('prunes retained partial entries that are outside the current document candidates', async () => {
    const { resolveSmartAudioBookLexicon } = await import('../../src/lib/server/smart-audio/book-lexicon');
    const result = await resolveSmartAudioBookLexicon({
      profile: {
        id: 'test',
        name: 'Test',
        aiModel: 'cleanup',
        pronunciationAiModel: 'pronunciation',
        customTtsPrompt: '',
        abbreviations: {},
        pronunciations: {},
        books: {},
        geminiApiKey: 'test-only-placeholder',
      },
      candidates: [{ term: 'λόγος', contexts: ['The λόγος appeared.'] }],
      existing: {
        ...lexicon,
        status: 'partial',
        definitionScanComplete: false,
        entries: {
          ...lexicon.entries,
          παλαιός: {
            term: 'παλαιός',
            pronunciation: '/pa.le.os/',
            definition: null,
            language: 'koine_greek',
          },
        },
      },
    });
    expect(result.status).toBe('complete');
    expect(result.entries).toEqual(lexicon.entries);
  });

  test('keeps Scholar mode exclusive while allowing the separate Audio Drama mode', () => {
    const defaults = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'src/lib/server/default_smart_audio_profiles.json'),
      'utf8',
    )) as { profiles: Array<{ name: string; workerMode?: string }> };
    const scholars = defaults.profiles.filter((profile) => profile.workerMode === 'scholar');
    expect(scholars).toHaveLength(1);
    expect(scholars[0]?.name).toMatch(/English Definitions/i);
    expect(defaults.profiles.filter((profile) => profile.workerMode === 'multi-voice'))
      .toEqual([expect.objectContaining({ name: 'LitRPG Audio Drama' })]);
    expect(defaults.profiles
      .filter((profile) => !['scholar', 'bibliography-catcher', 'multi-voice', 'drama-gemini-tts'].includes(profile.workerMode || ''))
      .every((profile) => profile.workerMode === 'standard'))
      .toBe(true);
  });
});
