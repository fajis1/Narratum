import { describe, expect, test } from 'vitest';
import { applyPronunciationPatches, assertPronunciationRepair, canonicalRepairTextFile, failedChapterReviewIssue, scanPronunciationIssues } from '../../src/lib/shared/pronunciation-issues';
import { reconcileSmartAudioPronunciations } from '../../src/lib/shared/smart-audio-cleanup';
import { getKokoroPronunciationWordWarnings } from '../../src/lib/shared/kokoro-pronunciation-policy';

const dictionary = { Aetherian: '/eɪθɪriən/', 'θεοῦ': '/θɛu/' };

describe('targeted pronunciation scan and patches', () => {
  test('creates an editable whole-chapter review item for a retained generation failure', () => {
    expect(failedChapterReviewIssue('Narration text.', 'TTS recording failed.')).toMatchObject({
      id: 'failed-chapter',
      start: 0,
      end: 15,
      text: 'Narration text.',
      replacement: 'Narration text.',
      reason: 'TTS recording failed.',
    });
  });
  test('does not send already-tagged suffixes to AI, but retains the complete optional-letter finding', () => {
    const tagged = '-[μός](/mɒs/) and -[μα](/mɑ/)';
    const text = `${Array(11).fill(tagged).join('. ')}. -(σ)[μός](/mɒs/)`;
    expect(scanPronunciationIssues(text)).toMatchObject([{ text: '-(σ)[μός](/mɒs/)' }]);
    expect(scanPronunciationIssues(text)).toHaveLength(1);
    expect(scanPronunciationIssues(tagged)).toEqual([]);
    expect(scanPronunciationIssues('-[μός](/bad split/)').length).toBeGreaterThan(0);
    expect(scanPronunciationIssues('-μός')[0].text).toBe('-μός');
  });
  test.each([
    ['[_[ἐπιποθῶ](/ɛpipoʊθoʊ/)_](/ɛpipoʊθoʊ/)', '[ἐπιποθῶ](/ɛpipoʊθoʊ/)'],
    ['[Ὁ](/hoʊ)', '[Ὁ](/hoʊ/)'],
    ['[ἀλλὰ](/ɑlɑ)', '[ἀλλὰ](/ɑlɑ/)'],
    ['[ἃ](/hɑ)', '[ἃ](/hɑ/)'],
  ])('normalizes report markup locally and idempotently: %s', (original, expected) => {
    const issues = scanPronunciationIssues(`Before ${original} after.`);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ text: original, replacement: expected });
    const proposed = applyPronunciationPatches(`Before ${original} after.`, issues, [{ id: '0', replacement: expected }]);
    expect(proposed).toBe(`Before ${expected} after.`);
    expect(() => assertPronunciationRepair(`Before ${original} after.`, proposed)).not.toThrow();
    expect(scanPronunciationIssues(proposed)).toEqual([]);
  });

  test('keeps the complete suffix and narrow elisions contextual, without weakening dictionary safeguards', () => {
    const original = 'Words ending in -(σ)[μός](/mɒs/) occur.';
    const issues = scanPronunciationIssues(original);
    expect(issues).toHaveLength(1);
    expect(issues[0].text).toBe('-(σ)[μός](/mɒs/)');
    const proposed = 'Words ending in [-(σ)μός](/smɒs/) occur.';
    expect(scanPronunciationIssues(proposed)).toEqual([]);
    expect(() => assertPronunciationRepair(original, proposed)).not.toThrow();
    for (const label of ['γ᾽', 'δ’', "γ'", 'γ᾿', 'δʼ']) {
      expect(scanPronunciationIssues(`[${label}](/ɡɛ/)`)).toEqual([]);
      expect(scanPronunciationIssues(`Before ${label} after.`)[0].text).toBe(label);
    }
    expect(scanPronunciationIssues('Before ᾿ after.')).toEqual([]);
    expect(scanPronunciationIssues('[δ᾽](/d)')[0].replacement).toBeUndefined();
    expect(scanPronunciationIssues('[σ](/s/)').length).toBeGreaterThan(0);
    expect(scanPronunciationIssues('[θ᾽](/θɛ/)').length).toBeGreaterThan(0);
    expect(getKokoroPronunciationWordWarnings('-(σ)μός').length).toBeGreaterThan(0);
    expect(getKokoroPronunciationWordWarnings('γ᾽').length).toBeGreaterThan(0);
  });

  test('bounds ambiguous nested regions without guessing or treating their IPA as OCR', () => {
    const original = '[τὸ δύνασθαι αὐτὸν](/toʊ/ [δύνασθαι](/dunɑsθaɪ/) [αὐτὸν](/aʊtoʊn/) [ἑαυτῷ](/hɛaʊtoʊ/) ἀρκεῖν)';
    const issues = scanPronunciationIssues(`Before ${original} after.`);
    expect(issues).toHaveLength(1);
    expect(issues[0].text).toBe(original);
    expect(issues[0].replacement).toBeUndefined();
    expect(scanPronunciationIssues('[_[ἐπιποθῶ](/ɛpipoʊθoʊ/)_](/different/)')[0].replacement).toBeUndefined();
    expect(scanPronunciationIssues('Χρισtῷ')[0].replacement).toBeUndefined();
    const proposed = '[τὸ](/toʊ/) [δύνασθαι](/dunɑsθaɪ/) [αὐτὸν](/aʊtoʊn/) [ἑαυτῷ](/hɛaʊtoʊ/) [ἀρκεῖν](/ɑrkeɪn/)';
    const sourceText = 'τὸ δύνασθαι αὐτὸν ἑαυτῷ ἀρκεῖν';
    expect(() => assertPronunciationRepair(original, proposed)).toThrow();
    expect(() => assertPronunciationRepair(original, proposed, { sourceText })).not.toThrow();
    expect(() => assertPronunciationRepair(original, proposed + ' [ἀρκεῖν](/ɑrkeɪn/)', { sourceText })).toThrow();
    expect(() => assertPronunciationRepair(original, proposed.replace('[τὸ](/toʊ/) ', ''), { sourceText })).toThrow();
    expect(() => assertPronunciationRepair(original, '[τὸ](/toʊ/) [δύνασθαι](/dunɑsθaɪ/) [αὐτὸν](/aʊtoʊn/)', { sourceText })).toThrow();
    expect(() => assertPronunciationRepair(original.replace(' ἀρκεῖν)', ' English ἀρκεῖν)'), proposed, { sourceText })).toThrow();
    expect(() => assertPronunciationRepair('τὸ θεῷ', '[θεῷ](/θeɪoʊ/) [τὸ](/toʊ/)')).toThrow();
  });
  test('joins tagged suffixes, bounds mixed-script OCR, and repairs closing delimiters', () => {
    expect(scanPronunciationIssues('[χάρι](/kɑrɪ/)τας', { 'χάριτας': '/kɑrɪtɑs/' })).toMatchObject([{ text: '[χάρι](/kɑrɪ/)τας', replacement: '[χάριτας](/kɑrɪtɑs/)' }]);
    expect(scanPronunciationIssues('Tὶ now.')[0].text).toBe('Tὶ');
    expect(scanPronunciationIssues('T[ὶ](/i/) now.')[0].text).toBe('T[ὶ](/i/)');
    expect(scanPronunciationIssues('[χάρι](/kɑrɪ/)[τας](/tɑs/)', { 'χάριτας': '/kɑrɪtɑs/' })[0].replacement).toBe('[χάριτας](/kɑrɪtɑs/)');
    const broken = '[ἁρπαγμός](/hɑrpɑɡmɒs/]';
    expect(scanPronunciationIssues(broken + ' next.')[0]).toMatchObject({ text: broken, replacement: '[ἁρπαγμός](/hɑrpɑɡmɒs/)' });
  });

  test('bounds each malformed closing delimiter without swallowing neighboring valid tags', () => {
    const first = '[ἀνθρώποις](/ɑnθroʊpɔɪs/]';
    const second = '[μικροχαρῶν](/mikroʊxɑroʊn/]';
    const text = `${first} [ἰσόθεον](/isoʊθɛɒn/) [ὄντα](/ɒntɑ/). ${second} [νομίζουσι](/nɒmɪzusɪ/).`;
    const issues = scanPronunciationIssues(text);
    expect(issues.map(issue => issue.text)).toEqual([first, second]);
    expect(issues.every(issue => issue.kind === 'formatting')).toBe(true);
    expect(issues.map(issue => issue.replacement)).toEqual([
      '[ἀνθρώποις](/ɑnθroʊpɔɪs/)',
      '[μικροχαρῶν](/mikroʊxɑroʊn/)',
    ]);
  });

  test('repairs an elided contextual form only from an approved complete-word pronunciation', () => {
    const text = 'Words [δ᾽](/d) [οὐδεὶς](/udeɪs/).';
    expect(scanPronunciationIssues(text)[0]).toMatchObject({ text: '[δ᾽](/d)', kind: 'contextual' });
    expect(scanPronunciationIssues(text)[0]).not.toHaveProperty('replacement');
    expect(scanPronunciationIssues(text, { 'δέ': '/dɛ/' })[0]).toMatchObject({
      text: '[δ᾽](/d)', kind: 'contextual', replacement: '[δ᾽](/dɛ/)',
    });
  });

  test('permits only source-supported corrupt-label reconstruction', () => {
    const previous = '[proseɪkoʊn](/proʊseɪkoʊn/)';
    const proposed = '[προσῆκόν](/proʊseɪkoʊn/)';
    expect(() => assertPronunciationRepair(previous, proposed)).toThrow('English');
    expect(() => assertPronunciationRepair(previous, proposed, { sourceText: 'Greek προσῆκόν here.' })).not.toThrow();
    expect(() => assertPronunciationRepair(previous, proposed, { sourceText: 'No evidence.' })).toThrow('English');
    expect(() => assertPronunciationRepair('[Aetherian](/bad split/)', proposed, { sourceText: 'προσῆκόν' })).toThrow('English');
  });

  test('partial proposal validation does not disable the recording gate', () => {
    const previous = 'τὸ θεῷ';
    const proposed = '[τὸ](/toʊ/) θεῷ';
    expect(() => assertPronunciationRepair(previous, proposed, { allowRemaining: true })).not.toThrow();
    expect(() => assertPronunciationRepair(previous, proposed)).toThrow('remain');
    expect(() => assertPronunciationRepair('English ' + previous, 'Changed ' + proposed, { allowRemaining: true })).toThrow();
  });
  test('repairs the complete bracketed region from chapter 0062', () => {
    const text = 'Equal [τῷ] θεῷ.';
    const issues = scanPronunciationIssues(text, { 'τῷ': '/toʊ/', 'θεῷ': '/θeɪoʊ/' });
    expect(issues[0].text).toBe('[τῷ]');
    const proposed = applyPronunciationPatches(text, issues, issues.map(issue => ({ id: issue.id, replacement: issue.replacement! })));
    expect(proposed).toBe('Equal [τῷ](/toʊ/) [θεῷ](/θeɪoʊ/).');
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
  });

  test('repairs chapter 167 bracketed phrase as one region without nesting or changing English', () => {
    const text = 'Seek not [μὴ ζητεῖτε] your own advantages, but be concerned [σκοπεῖτε](/skoʊpeɪtɛ/) also for others.';
    const issues = scanPronunciationIssues(text, { 'μὴ': '/meɪ/', 'ζητεῖτε': '/zeɪ teɪ tɛ/' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ text: '[μὴ ζητεῖτε]', replacement: '[μὴ](/meɪ/) [ζητεῖτε](/zeɪteɪtɛ/)' });
    const proposed = applyPronunciationPatches(text, issues, [{ id: '0', replacement: issues[0].replacement! }]);
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
    expect(scanPronunciationIssues(proposed)).toHaveLength(0);
    expect(() => assertPronunciationRepair(text, proposed.replace('advantages', 'profits'))).toThrow();
    expect(() => assertPronunciationRepair(text, proposed.replace('[μὴ](/meɪ/)', ''))).toThrow();
    expect(scanPronunciationIssues(text, { 'μὴ': '/meɪ/' })[0].replacement).toBeUndefined();
  });

  test('does not confuse slash alternatives with IPA delimiters', () => {
    const text = 'Forms θεῷ/θέοισιν remain.';
    const proposed = 'Forms [θεῷ](/θeɪoʊ/)/[θέοισιν](/θɛoʊeɪsɪn/) remain.';
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
    expect(() => assertPronunciationRepair(text, proposed.replace('remain', 'change'))).toThrow();
  });

  test('validates compacted single-word dictionary IPA before selecting it', () => {
    expect(scanPronunciationIssues('τυγχάνω', { 'τυγχάνω': '/t juŋ k ɑ n oʊ/' })[0].replacement).toBe('[τυγχάνω](/tjuŋkɑnoʊ/)');
    expect(scanPronunciationIssues('τυγχάνω', { 'τυγχάνω': '/[broken]/' })[0].replacement).toBeUndefined();
  });

  test('finds and repairs malformed single-word IPA from an exact safe dictionary match', () => {
    const text = 'The [Aetherian](/bad split/) arrived.';
    const issues = scanPronunciationIssues(text, dictionary);
    expect(issues).toHaveLength(1);
    expect(issues[0].replacement).toBe('[Aetherian](/eɪθɪriən/)');
    const proposed = applyPronunciationPatches(text, issues, [{ id: issues[0].id, replacement: issues[0].replacement! }]);
    expect(proposed).toBe('The [Aetherian](/eɪθɪriən/) arrived.');
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
    expect(reconcileSmartAudioPronunciations(text, dictionary)).toBe(proposed);
  });

  test('catches the real mixed Greek example without treating English as a repair region', () => {
    const text = String.raw`from the gifts of God ([\ἐκ](/ɛk/) τῶν τοῦ [θε](/θɛ/)(οῦ) δωρεῶν).`;
    const issues = scanPronunciationIssues(text, dictionary);
    expect(issues.some(issue => issue.text.includes('[\\ἐκ]'))).toBe(true);
    expect(issues.some(issue => issue.text === 'τῶν')).toBe(true);
    expect(issues.some(issue => issue.text === 'τοῦ')).toBe(true);
    expect(issues.some(issue => issue.text.includes('[θε](/θɛ/)(οῦ)') && issue.replacement === '[θε(οῦ)](/θɛu/)')).toBe(true);
    expect(issues.some(issue => issue.text === 'δωρεῶν')).toBe(true);
    expect(issues.every(issue => !issue.text.includes('gifts'))).toBe(true);
  });

  test('retains complete tags and ordinary links; flags empty punctuation and broken tags', () => {
    expect(scanPronunciationIssues('A [link](https://example.org) and [θε(οῦ)](/θɛu/).')).toEqual([]);
    expect(scanPronunciationIssues('God ([θεοῦ](/θɛu/)).')).toEqual([]);
    expect(scanPronunciationIssues('word () end')).toMatchObject([{ text: '()', replacement: '' }]);
    expect(scanPronunciationIssues('[Aetherian](/bad')).toHaveLength(1);
  });

  test('requires review for unknown pronunciations and finds Hebrew', () => {
    const issues = scanPronunciationIssues('Read שלום now.');
    expect(issues).toHaveLength(1);
    expect(issues[0].replacement).toBeUndefined();
    expect(issues[0].context).toBe('Read שלום now.');
  });

  test('rejects duplicate patches, unrelated English edits, numbers, and new voices', () => {
    const text = 'The [Aetherian](/bad split/) has 85 coins.';
    const issues = scanPronunciationIssues(text, dictionary);
    const good = { id: '0', replacement: '[Aetherian](/eɪθɪriən/)' };
    expect(() => applyPronunciationPatches(text, issues, [good, good])).toThrow('duplicate');
    expect(() => applyPronunciationPatches(text, issues, [{ ...good, replacement: 'Someone' }])).toThrow('English');
    expect(() => applyPronunciationPatches(text, issues, [{ ...good, replacement: '<voice name="af_bella">Aetherian</voice>' }])).toThrow('voice');
    const proposed = applyPronunciationPatches(text, issues, [good]);
    expect(() => assertPronunciationRepair(text, proposed.replace('85', '86'))).toThrow();
    expect(() => assertPronunciationRepair(text, proposed.replace('coins', 'dollars'))).toThrow();
    expect(() => applyPronunciationPatches(text.replace('Aetherian', 'Another'), issues, [good])).toThrow('changed');
  });

  test('requires explicit reviewer override for a confirmed cross-script OCR correction', () => {
    const previous = 'The quotation contains [ἔرως](/ɛroʊs/).';
    const proposed = 'The quotation contains [ἔρως](/ɛroʊs/).';
    expect(() => assertPronunciationRepair(previous, proposed)).toThrow('source');
    expect(() => assertPronunciationRepair(previous, proposed, { allowSourceEvidenceOverride: true })).not.toThrow();
  });

  test('preserves Audio Drama speaker boundaries and rejects unrepaired output', () => {
    const text = '<voice name="af_bella">The [Aetherian](/bad split/) came.</voice>\n<voice name="am_adam">Hello.</voice>';
    const issues = scanPronunciationIssues(text, dictionary);
    const proposed = applyPronunciationPatches(text, issues, [{ id: '0', replacement: issues[0].replacement! }]);
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
    expect(() => assertPronunciationRepair(text, proposed.replace('am_adam', 'af_bella'))).toThrow();
    expect(() => assertPronunciationRepair(text, text)).toThrow('remain');
    expect(canonicalRepairTextFile('0107__rejected.txt')).toBe('0107__text.txt');
  });

  test('multi-word English phrase tags are flagged as unsafe and can be split into individual-word tags', () => {
    // Scenario from real repair report: [I live](/laɪv/) is a phrase tag that
    // the validator correctly rejects because "I live" is not one dictionary word.
    const text = '[I live](/laɪv/) by faith in the Son of God.';
    const issues = scanPronunciationIssues(text);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('unsafe_pronunciation');
    expect(issues[0].text).toBe('[I live](/laɪv/)');

    // The repair AI should split this into individual words.
    // "I" needs no special pronunciation; "live" (verb) gets the soft-i heteronym tag.
    const repairPatch = { id: issues[0].id, replacement: 'I [live](!/lɪv/)' };
    const proposed = applyPronunciationPatches(text, issues, [repairPatch]);
    expect(proposed).toBe('I [live](!/lɪv/) by faith in the Son of God.');

    // The repaired text must pass without any remaining issues.
    expect(scanPronunciationIssues(proposed)).toEqual([]);
    expect(() => assertPronunciationRepair(text, proposed)).not.toThrow();
  });

  test('multi-word English phrase split preserves visible English through applyPronunciationPatches', () => {
    // Verify the English-preservation check accepts the split because
    // visibleEnglish("[I live](/laɪv/)") === visibleEnglish("I [live](!/lɪv/)")
    const text = 'As Paul wrote: [I live](/laɪv/) by faith.';
    const issues = scanPronunciationIssues(text);
    expect(issues[0].kind).toBe('unsafe_pronunciation');
    // Split repair: remove the phrase tag, tag only the heteronym word.
    const patch = { id: issues[0].id, replacement: 'I [live](!/lɪv/)' };
    expect(() => applyPronunciationPatches(text, issues, [patch])).not.toThrow();
    // A repair that changes the visible English words must be rejected.
    const badPatch = { id: issues[0].id, replacement: 'He [lives](!/lɪvz/)' };
    expect(() => applyPronunciationPatches(text, issues, [badPatch])).toThrow('English');
  });
});

