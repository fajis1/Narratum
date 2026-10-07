import { describe, expect, test } from 'vitest';
import {
  buildSmartAudioCleanupPrompt,
  discardInvalidSmartAudioPronunciationTags,
  extractNarratableSmartAudioSourceText,
  FINAL_SMART_AUDIO_PRONUNCIATION_CHECK,
  hasConfirmedSmartAudioEndMatterHint,
  hasSubstantialSmartAudioSourceText,
  isScholarLikeSmartAudioMode,
  normalizeSmartAudioPronunciationTags,
  reconcileSmartAudioPronunciations,
  resolveSmartAudioWorkerResult,
  stripSmartAudioInputMarkers,
  validateSmartAudioOutput,
} from '../../src/lib/shared/smart-audio-cleanup';

describe('supported source scripts in final pronunciation validation', () => {
  test.each(['[ኵሎ](/kulo/)', '[λόγος](/lɒɡɒs/)', '[שלום](/ʃɑloʊm/)'])('accepts a supported single-script label: %s', tag => {
    expect(validateSmartAudioOutput(tag)).toBe(tag);
  });

  test.each(['ኵሎabc', 'ኵሎθε', 'ኵሎשלום', 'θεabc', 'שלוםabc', 'θεשלום'])('rejects a mixed-script source label: %s', word => {
    const tag = `[${word}](/kulo/)`;
    expect(() => validateSmartAudioOutput(tag)).toThrow('mixed-script OCR text');
    expect(() => normalizeSmartAudioPronunciationTags(tag)).toThrow('mixed-script OCR text');
  });
});

describe('Smart Audio cleanup contract', () => {
  test('appends mandatory runtime rules after a stale saved prompt', () => {
    const prompt = buildSmartAudioCleanupPrompt(
      'Old profile rule: return an empty string when nothing should be narrated.',
    );

    expect(prompt).toContain('Old profile rule: return an empty string');
    expect(prompt).toContain('these rules override conflicting instructions above');
    expect(prompt).toContain('return exactly [OMIT]');
    expect(prompt.lastIndexOf('return exactly [OMIT]')).toBeGreaterThan(
      prompt.indexOf('return an empty string'),
    );
    expect(prompt).toContain('Reconstruct OCR-damaged words when context');
    expect(prompt).toContain('Always output the reconstructed complete word');
    expect(prompt).toContain('Pronunciation markup may wrap exactly one corrected lexical word');
    expect(prompt).toContain('never wrap a phrase, clause, or multiple space-separated words');
    expect(prompt).toContain('Repair contextually clear mixed-script OCR');
    expect(prompt).toContain('Never preserve mixed-script corruption inside a pronunciation tag');
    expect(prompt).toContain('Never evade your own rules by wrapping an entire quotation');
    expect(prompt).toContain('Apply omission rules block by block');
    expect(prompt).toContain('only at or after 70% through the book');
    expect(prompt).toContain('If uncertain, preserve the original text');
    expect(prompt.lastIndexOf('Pronunciation markup may wrap exactly one corrected lexical word')).toBeGreaterThan(
      prompt.indexOf('Old profile rule'),
    );
    expect(FINAL_SMART_AUDIO_PRONUNCIATION_CHECK).toContain(
      "INVALID: [καθ' υἱοθεσίαν δὲ](/kɑθ huioʊθɛsiɑn dɛ/)",
    );
    expect(FINAL_SMART_AUDIO_PRONUNCIATION_CHECK).toContain(
      'VALID: [τὴν](/teɪn/) [θέσιν](/θɛsɪn/)',
    );
    expect(FINAL_SMART_AUDIO_PRONUNCIATION_CHECK).toContain(
      'INVALID: [υἱός](/huɪɒn/)',
    );
    expect(FINAL_SMART_AUDIO_PRONUNCIATION_CHECK).toContain(
      'INVALID: [θετὸν](/θɛtɒs/)',
    );
    expect(FINAL_SMART_AUDIO_PRONUNCIATION_CHECK).toContain(
      'INVALID: [υἱοῦσθαι](/juoʊsθaɪ/)',
    );
  });

  test('removes private input markers without removing their narrative content', () => {
    const source = [
      '[LAYOUT_ENGINE_TAG: PARAGRAPH_TITLE]',
      'A Real Chapter',
      '',
      '[SYSTEM HINT: internal only]',
      'Narrative body.',
      '<openreader-layout kind="text">More prose.</openreader-layout>',
    ].join('\n');

    expect(stripSmartAudioInputMarkers(source)).toBe(
      'A Real Chapter\n\nNarrative body.\nMore prose.',
    );
  });

  test('builds a deterministic source fallback from narratable layout blocks only', () => {
    const source = [
      '[LAYOUT_ENGINE_TAG: PARAGRAPH_TITLE]',
      'Chapter Nine',
      '[LAYOUT_ENGINE_TAG: TEXT]',
      'A coherent theological paragraph remains for narration.',
      '[LAYOUT_ENGINE_TAG: REFERENCE]',
      'Smith 1999 42. Jones 2001 15.',
      '[LAYOUT_ENGINE_TAG: TABLE]',
      'Column A Column B 1 2 3',
    ].join('\n');

    expect(extractNarratableSmartAudioSourceText(source)).toBe(
      'Chapter Nine\n\nA coherent theological paragraph remains for narration.',
    );
  });

  test('distinguishes explicit omission from cleaned text', () => {
    expect(resolveSmartAudioWorkerResult({
      status: 'success',
      outcome: 'omitted',
      cleaned_text: '',
    })).toEqual({ outcome: 'omitted', text: '' });

    expect(resolveSmartAudioWorkerResult({
      status: 'success',
      outcome: 'cleaned',
      cleaned_text: 'Narrative body.',
    })).toEqual({ outcome: 'cleaned', text: 'Narrative body.' });
  });

  test('keeps legacy sentinel compatibility but rejects ambiguous empty output', () => {
    expect(resolveSmartAudioWorkerResult({
      status: 'success',
      cleaned_text: '[OMITTED]',
    })).toEqual({ outcome: 'omitted', text: '' });

    expect(() => resolveSmartAudioWorkerResult({
      status: 'success',
      cleaned_text: '',
    })).toThrow('returned empty text instead of [OMIT]');
  });

  test('rejects omission of a substantial source chunk but permits a short non-narrative omission', () => {
    const substantialSource = 'This is a narratable sentence with meaningful book content. '.repeat(40);
    expect(hasSubstantialSmartAudioSourceText(substantialSource)).toBe(true);
    expect(() => resolveSmartAudioWorkerResult({
      status: 'success',
      outcome: 'omitted',
      cleaned_text: '',
    }, { sourceText: substantialSource })).toThrow(
      'omitted a substantial source chunk',
    );

    expect(resolveSmartAudioWorkerResult({
      status: 'success',
      outcome: 'omitted',
      cleaned_text: '',
    }, { sourceText: 'Copyright page.' })).toEqual({ outcome: 'omitted', text: '' });
  });

  test('allows whole-section omission only when OpenReader confirmed end matter', () => {
    const sourceText = [
      '[SYSTEM HINT: The layout engine detected that this section is located in the end-matter of the book.]',
      '[LAYOUT_ENGINE_TAG: TEXT]',
      'Bibliography entry discussion. '.repeat(40),
    ].join('\n');
    expect(hasConfirmedSmartAudioEndMatterHint(sourceText)).toBe(true);
    expect(resolveSmartAudioWorkerResult({
      status: 'success',
      outcome: 'omitted',
      cleaned_text: '',
    }, {
      allowSubstantialOmission: true,
      sourceText,
    })).toEqual({ outcome: 'omitted', text: '' });
  });

  test('rejects leaked internal markers before TTS or storage', () => {
    for (const cleanedText of [
      '[LAYOUT_ENGINE_TAG: TEXT]\nNarrative body.',
      '[SYSTEM HINT: internal only]\nNarrative body.',
      '<openreader-layout kind="text">Narrative body.</openreader-layout>',
      'Narrative body.\n\n[CHAPTER_TITLE: Hidden Tag]',
      'Narrative body, then [OMIT].',
    ]) {
      expect(() => resolveSmartAudioWorkerResult({
        status: 'success',
        outcome: 'cleaned',
        cleaned_text: cleanedText,
      })).toThrow('internal control marker');
    }
  });

  test('splits safely aligned phrase pronunciations into individual word tags', () => {
    expect(normalizeSmartAudioPronunciationTags(
      "[καθ' υἱοθεσίαν δὲ](/kɑθ huioʊθɛsiɑn dɛ/)",
    )).toBe("[καθ'](/kɑθ/) [υἱοθεσίαν](/huioʊθɛsiɑn/) [δὲ](/dɛ/)");
    expect(normalizeSmartAudioPronunciationTags(
      '[καὶ τὸ ἄγιον βάπτισμα](/kaɪ toʊ ɑɡioʊn bɑptɪsmɑ/)',
    )).toBe('[καὶ](/kaɪ/) [τὸ](/toʊ/) [ἄγιον](/ɑɡioʊn/) [βάπτισμα](/bɑptɪsmɑ/)');
  });

  test('repairs an unambiguous Greek OCR substitution but rejects ambiguous mixed-script text', () => {
    expect(() => normalizeSmartAudioPronunciationTags(
      '[τὴν θέσιν](/teɪn/)',
    )).toThrow('cannot be aligned safely');
    expect(normalizeSmartAudioPronunciationTags(
      '[ἡgούμενοι](/heɪɡumɛnoɪ/)',
    )).toBe('[ἡγούμενοι](/heɪɡumɛnoɪ/)');
    expect(() => normalizeSmartAudioPronunciationTags(
      '[ἄγiov](/ɑɡioʊn/)',
    )).toThrow('mixed-script OCR text');
  });

  test('repairs mixed-script OCR only through a unique authoritative dictionary match', () => {
    expect(reconcileSmartAudioPronunciations(
      '[σεμnos](/wrong/) [σύμμορφον](/wrong-s/)',
      {
        'σεμνός': '/sɛmnos/',
        'σύμμορφον': '/sɪmmɔːrfɒn/',
      },
    )).toBe('[σεμνός](/sɛmnos/) [σύμμορφον](/sɪmmɔːrfɒn/)');

    expect(() => reconcileSmartAudioPronunciations(
      '[σεμnos](/wrong/)',
      {},
    )).toThrow('mixed-script OCR text');
    expect(() => reconcileSmartAudioPronunciations(
      '[σεμnos](/wrong/)',
      { 'σεμνός': '/first/', 'σεμνος': '/second/' },
    )).toThrow('mixed-script OCR text');
  });

  test('discards only unsafe pronunciation markup as the final safe fallback', () => {
    const fallback = discardInvalidSmartAudioPronunciationTags(
      'Before [σεμnos](/wrong/) and [λόγος](/loɡos/) after.',
      { 'λόγος': '/loɡos/' },
    );

    expect(fallback.text).toBe('Before σεμnos and [λόγος](/loɡos/) after.');
    expect(fallback.discardedTags).toBe(1);
    expect(fallback.errors[0]).toContain('mixed-script OCR text');
  });

  test('rejects obvious Greek inflection-ending mismatches', () => {
    expect(() => normalizeSmartAudioPronunciationTags('[υἱός](/huɪɒn/)')).toThrow(
      'does not match the visible Greek inflection ending',
    );
    expect(() => normalizeSmartAudioPronunciationTags('[υἱόν](/huioʊs/)')).toThrow(
      'does not match the visible Greek inflection ending',
    );
    expect(normalizeSmartAudioPronunciationTags('[υἱός](/huioʊs/) [υἱόν](/huioʊn/)')).toBe(
      '[υἱός](/huioʊs/) [υἱόν](/huioʊn/)',
    );
  });

  test('rejects a dropped rough-breathing h from Greek υἱ- words', () => {
    expect(() => normalizeSmartAudioPronunciationTags('[υἱοῦσθαι](/juoʊsθaɪ/)')).toThrow(
      'drops the rough-breathing h',
    );
    expect(normalizeSmartAudioPronunciationTags('[υἱοῦσθαι](/huioʊsθaɪ/)')).toBe(
      '[υἱοῦσθαι](/huioʊsθaɪ/)',
    );
  });

  test('makes a known dictionary pronunciation authoritative before validation', () => {
    expect(resolveSmartAudioWorkerResult({
      status: 'success',
      outcome: 'cleaned',
      cleaned_text: '[ὑμῖν](/hjuːmis/)',
    }, {
      authoritativePronunciations: { 'ὑμῖν': '/hjumin/' },
    })).toEqual({ outcome: 'cleaned', text: '[ὑμῖν](/hjumin/)' });
    expect(resolveSmartAudioWorkerResult({
      status: 'success',
      outcome: 'cleaned',
      cleaned_text: '[ἡgούμενοι](/wrong/)',
    }, {
      authoritativePronunciations: { 'ἡγούμενοι': '/heɪɡumɛnoɪ/' },
    })).toEqual({ outcome: 'cleaned', text: '[ἡγούμενοι](/heɪɡumɛnoɪ/)' });
  });

  test('reconciles split phrase tags and canonically equivalent Unicode without changing visible text', () => {
    const decomposed = 'ὑμῖν';
    const source = `[${decomposed} λόγος](/wrong wrong/)`;
    expect(reconcileSmartAudioPronunciations(source, {
      'ὑμῖν': '/hjumin/',
      'λόγος': '/loɡos/',
    })).toBe(`[${decomposed}](/hjumin/) [λόγος](/loɡos/)`);
  });

  test('uses only an unambiguous case-folded match and leaves unknown words unchanged', () => {
    expect(reconcileSmartAudioPronunciations(
      '[LOGOS](/first/) [Other](/untouched/)',
      { Logos: '/loɡos/' },
    )).toBe('[LOGOS](/loɡos/) [Other](/untouched/)');
    expect(reconcileSmartAudioPronunciations(
      '[WORD](/gemini/)',
      { Word: '/one/', word: '/two/' },
    )).toBe('[WORD](/gemini/)');
  });

  test('compacts phoneme/syllable whitespace for single-word dictionary entries', () => {
    expect(reconcileSmartAudioPronunciations(
      '[Seekland](/wrong/)',
      { 'Seekland': '/siːk lənd/' },
    )).toBe('[Seekland](/siːklənd/)');
  });

  test('treats Scholar and bibliography-catcher as the same structural mode', () => {
    expect(isScholarLikeSmartAudioMode('scholar')).toBe(true);
    expect(isScholarLikeSmartAudioMode('bibliography-catcher')).toBe(true);
    expect(isScholarLikeSmartAudioMode('standard')).toBe(false);
  });
});
