import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  createGeminiHttpError,
  collectGeminiPronunciationRepairRequests,
  foreignWordCandidateCacheKey,
  findLatestForeignWordScanJob,
  GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA,
  GeminiHttpError,
  mergeGeminiPronunciationRepairResults,
  isRejectedLatinTransliteration,
  isUsableForeignWordCandidate,
  parseForeignWordCandidateCache,
  parseGeminiForeignWordResults,
} from '@/lib/server/smart-audio/gemini-foreign-word-scan';

describe('Gemini foreign-word structured output', () => {
  test('uses a lowercase JSON Schema array with explicit term fields', () => {
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.type).toBe('array');
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.items.type).toBe('object');
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.items.properties.term.type).toBe('string');
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.items.properties.definitionOmitted.type).toBe('boolean');
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.items.properties.ocrFragment.type).toBe('boolean');
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.items.required).toContain('term');
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.items.required).toContain('definitionOmitted');
    expect(GEMINI_FOREIGN_WORD_RESPONSE_JSON_SCHEMA.items.required).toContain('ocrFragment');
  });

  test('parses result arrays and recovers complete entries from truncation', () => {
    const complete = JSON.stringify([{
      term: 'λόγος',
      pronunciations: ['/loʊɡɒs/'],
    }]);
    expect(parseGeminiForeignWordResults(complete)).toEqual({
      results: [{ term: 'λόγος', pronunciations: ['/loʊɡɒs/'] }],
      repaired: false,
    });

    expect(parseGeminiForeignWordResults(`[${JSON.stringify({
      term: 'λόγος',
      pronunciations: ['/loʊɡɒs/'],
    })}, {"term":`)).toEqual({
      results: [{ term: 'λόγος', pronunciations: ['/loʊɡɒs/'] }],
      repaired: true,
    });
  });

  test('rejects the legacy dynamic object response shape', () => {
    expect(() => parseGeminiForeignWordResults(JSON.stringify({
      λόγος: { pronunciations: ['/loʊɡɒs/'] },
    }))).toThrow('expected a JSON array');
  });

  test('preserves useful HTTP details while redacting keys', () => {
    const error = createGeminiHttpError(400, {
      error: { message: 'Invalid schema for key=secret-key\nadditionalProperties' },
    }, ['secret-key']);
    expect(error).toBeInstanceOf(GeminiHttpError);
    expect(error.status).toBe(400);
    expect(error.message).toBe(
      'Gemini request failed (HTTP 400): Invalid schema for key=[REDACTED] additionalProperties',
    );
  });

  test('scopes cached PDF candidates to the user, document, and scan options', () => {
    const base = {
      userId: 'user-a',
      documentId: 'document-a',
      mode: 'all_foreign',
      target: 80,
      query: null,
    };
    expect(foreignWordCandidateCacheKey(base)).toBe(foreignWordCandidateCacheKey(base));
    expect(foreignWordCandidateCacheKey(base)).not.toBe(foreignWordCandidateCacheKey({
      ...base,
      mode: 'greek_hebrew',
    }));
    expect(parseForeignWordCandidateCache(JSON.stringify({
      version: 11,
      words: [{ word: 'λόγος' }],
    }))).toEqual([{ word: 'λόγος' }]);
    expect(parseForeignWordCandidateCache(JSON.stringify({
      version: 10,
      words: [{ word: 'old-fragment' }],
    }))).toBeNull();
    expect(parseForeignWordCandidateCache(JSON.stringify({
      version: 8,
      words: [{ word: 'stale' }],
    }))).toBeNull();
    expect(parseForeignWordCandidateCache('{invalid')).toBeNull();
  });

  test('excludes multi-word phrases and IPA keys from the reusable dictionary candidate list', () => {
    expect(isUsableForeignWordCandidate({ word: 'λόγος' })).toBe(true);
    expect(isUsableForeignWordCandidate({ word: 'kol-hannōgēaʿ yiqdāʃ' })).toBe(false);
    expect(isUsableForeignWordCandidate({ word: '/koʊl-hɑnnoʊgɛɑ jikdɑʃ/' })).toBe(false);
    expect(isUsableForeignWordCandidate({ word: '   ' })).toBe(false);
  });

  test('stops and fails the job after a terminal Gemini HTTP error', () => {
    const route = readFileSync(resolve(
      process.cwd(),
      'src/app/api/documents/scan-foreign-words/route.ts',
    ), 'utf8');
    expect(route).toContain('err instanceof GeminiHttpError && (err.status === 400 || err.status === 429 || err.status === 503)');
    expect(route).toContain('terminalGeminiError = message;');
    expect(route).toContain("status: terminalGeminiError ? 'failed' : 'completed'");
  });

  test('finds an active scan for the requested user and document', () => {
    const jobs = [
      JSON.stringify({ id: 'other-user', userId: 'user-b', documentId: 'doc-a', status: 'running', updatedAt: 30 }),
      JSON.stringify({ id: 'completed', userId: 'user-a', documentId: 'doc-a', status: 'completed', updatedAt: 20 }),
      JSON.stringify({ id: 'active', userId: 'user-a', documentId: 'doc-a', status: 'running', updatedAt: 10 }),
    ];
    expect(findLatestForeignWordScanJob(jobs, 'user-a', 'doc-a')?.id).toBe('active');
    expect(findLatestForeignWordScanJob(jobs, 'user-b', 'doc-a')?.id).toBe('other-user');
    expect(findLatestForeignWordScanJob(jobs, 'user-a', 'doc-b')).toBeNull();
  });

  test('reattaches to exactly one active legacy scan without guessing between several', () => {
    const oneLegacy = [
      { id: 'legacy', userId: 'user-a', status: 'running', updatedAt: 10 },
    ];
    expect(findLatestForeignWordScanJob(oneLegacy, 'user-a', 'doc-a')?.id).toBe('legacy');
    expect(findLatestForeignWordScanJob([
      ...oneLegacy,
      { id: 'legacy-2', userId: 'user-a', status: 'queued', updatedAt: 20 },
    ], 'user-a', 'doc-a')).toBeNull();
  });

  test('requests one correction for omitted, unsafe, or incomplete pronunciation results', () => {
    const terms = [
      { term: 'υἱοὶ', contexts: [], currentPronunciation: null },
      { term: 'κτλ', contexts: [], currentPronunciation: null },
      { term: 'λόγος', contexts: [], currentPronunciation: null },
    ];
    const repairs = collectGeminiPronunciationRepairRequests(terms, [
      { term: 'υἱοὶ', pronunciations: ['/hyjoɪ/'] },
      { term: 'κτλ', pronunciations: ['/K, T, L/'] },
    ]);
    expect(repairs.map(({ term }) => term)).toEqual(['υἱοὶ', 'κτλ', 'λόγος']);
    expect(repairs[0].rejectedPronunciations[0].violations[0]).toContain('adjacent /y/ and /j/');
    expect(repairs[1].acceptedPronunciations).toEqual(['/K, T, L/']);
    expect(repairs[1].choicesNeeded).toBe(4);
    expect(repairs[2].rejectedPronunciations[0].violations[0]).toContain('omitted');
  });

  test('does not send a Gemini-confirmed OCR fragment through pronunciation repair', () => {
    const repairs = collectGeminiPronunciationRepairRequests([
      { term: 'θεσ', contexts: ['vio[θεσ]iα'], currentPronunciation: null, ocrSuspect: true },
    ], [{ term: 'θεσ', ocrFragment: true, pronunciations: [] }]);
    expect(repairs).toEqual([]);
  });

  test('accepts Gemini rejection of an unrelated Latin transliteration candidate', () => {
    const term = {
      term: 'Bradford',
      contexts: ['Bradford discusses the passage.'],
      currentPronunciation: null,
      latinTransliterationCandidate: true,
    };
    const result = {
      term: 'Bradford',
      language: 'other',
      pronunciations: [],
    };

    expect(isRejectedLatinTransliteration(term, result)).toBe(true);
    expect(collectGeminiPronunciationRepairRequests([term], [result])).toEqual([]);
    expect(isRejectedLatinTransliteration(term, {
      ...result,
      language: 'koine_greek',
    })).toBe(false);
  });

  test('merges only warning-free correction choices', () => {
    expect(mergeGeminiPronunciationRepairResults(
      [{ term: 'υἱοὶ', pronunciations: ['/hyjoɪ/'], language: 'koine_greek' }],
      [{ term: 'υἱοὶ', pronunciations: ['/huːɔɪ/', '/hjjɔɪ/'], needsReview: false }],
    )).toEqual([{
      term: 'υἱοὶ',
      pronunciations: ['/huːɔɪ/'],
      language: 'koine_greek',
      needsReview: false,
    }]);
  });

  test('limits scan quality correction to one Gemini pass', () => {
    const route = readFileSync(resolve(
      process.cwd(),
      'src/app/api/documents/scan-foreign-words/route.ts',
    ), 'utf8');
    expect(route).toContain('This is the only automatic correction pass');
    expect(route.match(/requestGeminiResults\(repairPrompt, 'pronunciation_quality_repair'\)/g))
      .toHaveLength(1);
    expect(route).not.toMatch(/while\s*\([^)]*(?:repair|correction)/i);
  });

  test('gives Gemini mixed-script OCR evidence and suppresses only confirmed fragments', () => {
    const route = readFileSync(resolve(
      process.cwd(),
      'src/app/api/documents/scan-foreign-words/route.ts',
    ), 'utf8');
    expect(route).toContain('ocrSuspect: scanned?.ocrSuspect === true');
    expect(route).toContain('ocrEvidence: Array.isArray(scanned?.ocrEvidence)');
    expect(route).toContain('Gemini, not a brittle local heuristic, made the final call.');
    expect(route).toContain('result.ocrFragment === true');
  });

  test('classifies rare Latin candidates before allowing dictionary persistence', () => {
    const route = readFileSync(resolve(
      process.cwd(),
      'src/app/api/documents/scan-foreign-words/route.ts',
    ), 'utf8');
    expect(route).toContain('latinTransliterationCandidate: scanned?.latinTransliterationCandidate === true');
    expect(route).toContain('isRejectedLatinTransliteration(requestedTerm, result)');
    expect(route.indexOf('isRejectedLatinTransliteration(requestedTerm, result)'))
      .toBeLessThan(route.indexOf('for (const p of prons)'));
    expect(route).toContain('rejectedLatinTransliterations.add(w);');
    expect(route.indexOf('rejectedLatinTransliterations.add(w);'))
      .toBeLessThan(route.indexOf('updatedGlobalWords.add(w);'));
  });
});
