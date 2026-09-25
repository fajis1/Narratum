import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildKokoroPronunciationInstructions,
  DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE,
  filterKokoroCompatiblePronunciationRecord,
  getKokoroPronunciationCompatibilityErrors,
  getKokoroPronunciationQualityWarnings,
  getKokoroPronunciationWordWarnings,
  KOKORO_COMPATIBILITY_POLICY,
  isKokoroSafePronunciation,
  normalizeKokoroPronunciationCandidate,
  resolvePronunciationGuidance,
} from '../../src/lib/shared/kokoro-pronunciation-policy';


describe('Kokoro pronunciation policy', () => {
  test('uses the universal guidance unless a profile explicitly customizes it', () => {
    expect(resolvePronunciationGuidance(null)).toBe(DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE);
    expect(resolvePronunciationGuidance({
      pronunciationPromptMode: 'default',
      customPronunciationPrompt: 'ignored',
    })).toBe(DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE);
    expect(resolvePronunciationGuidance({
      pronunciationPromptMode: 'custom',
      customPronunciationPrompt: 'LitRPG names should use broad English vowels.',
    })).toBe('LitRPG names should use broad English vowels.');
  });

  test('always places the required compatibility policy after customizable guidance', () => {
    const instructions = buildKokoroPronunciationInstructions({
      pronunciationPromptMode: 'custom',
      customPronunciationPrompt: 'Profile-only guidance.',
    });
    expect(instructions).toContain('Profile-only guidance.');
    expect(instructions).toContain(KOKORO_COMPATIBILITY_POLICY);
    expect(instructions.indexOf(KOKORO_COMPATIBILITY_POLICY)).toBeGreaterThan(instructions.indexOf('Profile-only guidance.'));
  });

  test('teaches biblical-language initialism handling', () => {
    expect(DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE).toContain('Greek and Hebrew initialisms');
    expect(DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE).toContain('κτλ');
    expect(DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE).toContain('K, T, L');
    expect(DEFAULT_KOKORO_PRONUNCIATION_GUIDANCE).toContain('takes precedence over the normal Greek/Hebrew IPA rule');
    expect(KOKORO_COMPATIBILITY_POLICY).toContain('NEVER place /y/ directly beside /j/');
    expect(KOKORO_COMPATIBILITY_POLICY).toContain('NEVER group capitals');
  });

  test('rejects the explicitly unsupported Kokoro patterns', () => {
    expect(getKokoroPronunciationCompatibilityErrors('/loʊɡɒs/')).toEqual([]);
    expect(getKokoroPronunciationCompatibilityErrors('/o/')).toContain('Standalone /o/ is not supported.');
    expect(getKokoroPronunciationCompatibilityErrors('/loʊˈɡɒs/')).toContain('Primary stress marker ˈ is not supported.');
    expect(getKokoroPronunciationCompatibilityErrors('/a.i/')).toContain('Syllable-boundary periods between vowels are not supported.');
    expect(getKokoroPronunciationCompatibilityErrors('/ʕɑ/')).toContain('True pharyngeal fricatives are not supported.');
  });

  test('filters incompatible learned pronunciations before persistence', () => {
    expect(filterKokoroCompatiblePronunciationRecord({
      logos: '/loʊɡɒs/',
      stressed: '/loʊˈɡɒs/',
      malformed: 'plain text',
    })).toEqual({ logos: '/loʊɡɒs/' });
  });

  test('flags legacy IPA patterns that Kokoro may spell aloud', () => {
    expect(getKokoroPronunciationQualityWarnings('huiothesia', '/hyjɔθesiːa/'))
      .toContain('Suspicious adjacent /y/ and /j/ phonemes may be spoken as separate letter names.');
    expect(getKokoroPronunciationQualityWarnings('λόγος', '/loʊɡɒs/')).toEqual([]);
    expect(isKokoroSafePronunciation('υἱοὶ', '/hyjoɪ/')).toBe(false);
    expect(isKokoroSafePronunciation('θν', '/TH, N/')).toBe(false);
    expect(isKokoroSafePronunciation('κτλ', '/K, T, L/')).toBe(true);
    expect(getKokoroPronunciationQualityWarnings('Φαραω', '/f ɑ r ɑ oʊ/')).toContain(
      'Spells a word as separate phoneme tokens and may sound stuttery.',
    );
    expect(isKokoroSafePronunciation('Φαραω', '/fɑrɑoʊ/')).toBe(true);
    expect(isKokoroSafePronunciation('NASA', '/NA, SA/')).toBe(false);
    expect(isKokoroSafePronunciation('NASA', '/N, A, S, A/')).toBe(true);
  });

  test('rejects malformed dictionary keys and stuttery OCR pronunciations', () => {
    expect(getKokoroPronunciationWordWarnings('/loʊɡɒs/')).toContain(
      'Dictionary word looks like IPA or slash-delimited markup.',
    );
    expect(getKokoroPronunciationWordWarnings('Yin Lime')).toContain(
      'Dictionary word must be one reusable term, not a phrase.',
    );
    expect(getKokoroPronunciationWordWarnings('πáντων')).toContain(
      'Dictionary word mixes Latin, Greek, or Hebrew scripts.',
    );
    expect(getKokoroPronunciationWordWarnings('τρρσσ')).toContain(
      'Dictionary word looks like a stray Greek consonant fragment.',
    );
    expect(getKokoroPronunciationWordWarnings('υἱοθεσ')).toContain(
      'Dictionary word ends with nonfinal Greek sigma and looks OCR-damaged.',
    );
    expect(getKokoroPronunciationWordWarnings('םלוע')).toContain(
      'Dictionary word starts with a Hebrew final-form letter and looks reversed or OCR-damaged.',
    );
    expect(getKokoroPronunciationWordWarnings('neɪp')).toContain(
      'Dictionary word looks like bare IPA rather than source text.',
    );
    expect(getKokoroPronunciationWordWarnings('π')).toContain(
      'Dictionary word is a single stray Greek consonant.',
    );
    expect(isKokoroSafePronunciation('λόγος', '/lɒ lɒ ɡɒs/')).toBe(false);
    expect(isKokoroSafePronunciation('ωνδ', '/O, N, D/')).toBe(false);
    expect(isKokoroSafePronunciation('κτλ', '/K, T, L/')).toBe(true);
    expect(getKokoroPronunciationQualityWarnings('υἱοθεσία', '/θɛs/')).toContain(
      'Pronunciation covers only part of the Greek source word.',
    );
    expect(getKokoroPronunciationQualityWarnings('ἀναιρεῖσθαι', '/naɪreɪsθaɪ/')).toContain(
      'Pronunciation covers only part of the Greek source word.',
    );
    expect(getKokoroPronunciationQualityWarnings('κατασκηνόω', '/kɑtɑskeɪnoʊ/')).toContain(
      'Pronunciation covers only part of the Greek source word.',
    );
    expect(isKokoroSafePronunciation('τύχηι', '/tukeɪ/')).toBe(true);
    expect(isKokoroSafePronunciation('Ιουδαίων', '/juːdɑɪoʊn/')).toBe(true);
    expect(getKokoroPronunciationQualityWarnings('πνεῦμα', '/pnjumɑ/')).toContain(
      'Pronounces a silent initial p before n.',
    );
    expect(isKokoroSafePronunciation('πνεῦμα', '/njumɑ/')).toBe(true);
    expect(isKokoroSafePronunciation('pneuma', '/pnjumɑ/')).toBe(false);
    expect(isKokoroSafePronunciation('pneuma', '/njumɑ/')).toBe(true);
    expect(filterKokoroCompatiblePronunciationRecord({
      'λόγος': '/loʊɡɒs/',
      'Yin Lime': '/jɪn laɪm/',
      'πáντων': '/pɑntoʊn/',
      'ωνδ': '/O, N, D/',
      'πνεῦμα': '/pnjumɑ/',
      'hāʾādām': '/hɑɑdɑm/',
      'ʾ': '/hɑɑdɑm/',
      'привет': '/privet/',
    })).toEqual({ 'λόγος': '/loʊɡɒs/', 'hāʾādām': '/hɑɑdɑm/' });
  });

  test('permits Hebrew and Arabic transliteration modifier characters in Latin tokens', () => {
    expect(getKokoroPronunciationWordWarnings('hāʾādām')).toEqual([]);
    expect(getKokoroPronunciationWordWarnings('baʿal')).toEqual([]);
    expect(getKokoroPronunciationWordWarnings('hā’ādām')).toEqual([]);
    expect(getKokoroPronunciationWordWarnings("hā'ādām")).toEqual([]);
    expect(isKokoroSafePronunciation('hāʾādām', '/hɑɑdɑm/')).toBe(true);
    expect(isKokoroSafePronunciation('baʿal', '/bɑɑl/')).toBe(true);
    expect(getKokoroPronunciationWordWarnings('ʾ')).toContain(
      'Dictionary word contains an unsupported or mixed writing system.',
    );
    expect(getKokoroPronunciationWordWarnings('привет')).toContain(
      'Dictionary word contains an unsupported or mixed writing system.',
    );
    expect(getKokoroPronunciationWordWarnings('שלוםʾ')).toContain(
      'Dictionary word contains an unsupported or mixed writing system.',
    );
  });

  test('all Gemini pronunciation paths consume the centralized instructions', () => {
    for (const relativePath of [
      'src/app/api/documents/scan-foreign-words/route.ts',
      'src/app/api/tts/refine-pronunciations/route.ts',
      'src/lib/server/audiobooks/worker.ts',
      'src/app/api/audiobook/chapter/route.ts',
    ]) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).toContain('buildKokoroPronunciationInstructions');
    }
    for (const relativePath of ['audiobook_worker.py', 'biblical_scholar_worker.py']) {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source, relativePath).toContain('pronunciation_prompt');
      expect(source, relativePath).toContain('{pronunciation_prompt}');
    }
  });

  test('foreign-word scans distinguish pre-existing library entries from Gemini picks', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/documents/scan-foreign-words/route.ts'), 'utf8');
    expect(source).toContain('preExistingGlobalWords');
    expect(source).toContain('geminiRecommendations');
    expect(source).toContain('libraryPronunciation');
    expect(source).toContain('pronunciationSource');
    expect(source).toContain('return one reliable Kokoro IPA pronunciation');
    expect(source).toContain('generateOnlyForNewWords');
    expect(source).toContain('globalChoices.slice(0, 1)');
    expect(source).toContain('after(async () =>');
    expect(source).toContain('Object.entries(geminiRecommendations)');
    expect(source).toContain('Warm only Gemini');
    expect(source).toContain('No API key is configured for the selected Smart Audio profile');
    expect(source).toContain("event: 'pdf.scan.gemini.batch.failed'");
    expect(source).toContain('acceptedChoices += 1');
    expect(source).toContain('generatedChoices: acceptedChoices');
    expect(source).toContain('librarySkipped: 0');
    expect(source).toContain('librarySkipped,');
    expect(source).not.toContain('wordsMissingOptions.reduce((total');
  });

  test('refinement exposes the configured paid backup key and explicit retry choice', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/api/tts/refine-pronunciations/route.ts'), 'utf8');
    expect(source).toContain('activeProfile?.backupGeminiApiKey');
    expect(source).toContain('useBackupKey');
    expect(source).toContain('canUseBackupKey');
    expect(source).toContain('retryAfter: 60');
  });

  test('does not modify the established document-cleaning preset prompts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/constants.ts'), 'utf8');
    expect(source).not.toContain('KOKORO PRONUNCIATION COMPATIBILITY POLICY');
    expect(source).toContain('1. FIX OCR AND HYPHENATION');
    expect(source).toContain('12. SECTION HEADING PACING');
  });

  test('normalizes candidate pronunciations with delimiters, whitespace compacting, and stress stripping', () => {
    // Delimiter wrapping
    expect(normalizeKokoroPronunciationCandidate('λόγος', 'loʊɡɒs')).toBe('/loʊɡɒs/');
    expect(normalizeKokoroPronunciationCandidate('λόγος', ' /loʊɡɒs/ ')).toBe('/loʊɡɒs/');
    // Fixing closing delimiter typo
    expect(normalizeKokoroPronunciationCandidate('λόγος', '/loʊɡɒs/]')).toBe('/loʊɡɒs/');
    // Markdown link unwrapping
    expect(normalizeKokoroPronunciationCandidate('λόγος', '[λόγος](/loʊɡɒs/)')).toBe('/loʊɡɒs/');
    expect(normalizeKokoroPronunciationCandidate('λόγος', '[loʊɡɒs]')).toBe('/loʊɡɒs/');
    // Stress mark stripping (Kokoro forbids primary stress ˈ)
    expect(normalizeKokoroPronunciationCandidate('λόγος', '/loʊˈɡɒs/')).toBe('/loʊɡɒs/');
    expect(normalizeKokoroPronunciationCandidate('בהמה', '/ˈbəheɪmɑː/')).toBe('/bəheɪmɑː/');
    // Whitespace compacting for single words
    expect(normalizeKokoroPronunciationCandidate('hāʾādām', '/hɑː dɑːm/')).toBe('/hɑːdɑːm/');
    expect(normalizeKokoroPronunciationCandidate('בהמה', '/bə heɪ mɑː/')).toBe('/bəheɪmɑː/');
    expect(normalizeKokoroPronunciationCandidate('Seekland', '/siːk lənd/')).toBe('/siːklənd/');
    // Initialisms preserve comma separation
    expect(normalizeKokoroPronunciationCandidate('κτλ', '/K, T, L/')).toBe('/K, T, L/');
    expect(normalizeKokoroPronunciationCandidate('κτλ', '/K,T,L/')).toBe('/K, T, L/');
    // Stripping OCR prefix digits
    expect(normalizeKokoroPronunciationCandidate('118Lamaštu', '/118lɑːmɑʃtuː/')).toBe('/lɑːmɑʃtuː/');
    // Invalid / unrecoverable candidates
    expect(normalizeKokoroPronunciationCandidate('word', null)).toBeNull();
    expect(normalizeKokoroPronunciationCandidate('word', '')).toBeNull();
    expect(normalizeKokoroPronunciationCandidate('word', 'unsupported-xyz-!@#$')).toBeNull();
  });
});
