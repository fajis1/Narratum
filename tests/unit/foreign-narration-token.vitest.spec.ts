import { expect, test } from 'vitest';
import { classifyForeignNarrationToken, containsForeignLexicalLetter } from '@/lib/shared/foreign-narration-token';
import { getKokoroPronunciationCompatibilityErrors } from '@/lib/shared/kokoro-pronunciation-policy';

test.each(['׃', '־', '׀', '׆', '\u05b0', '\u0313', '᾿'])('script-associated punctuation/marks are not lexical: %s', token => {
  expect(containsForeignLexicalLetter(token)).toBe(false);
  expect(classifyForeignNarrationToken(token, token, 0, token.length).kind).toBe('punctuation');
});
test.each(['The Θ edition.', 'The Σ translation.', 'manuscript θ', 'symbol π', 'the letter β', 'Dan. Θ', 'Daniel chapter 4 verse 33 Θ', 'Dan. 4:30 Θ', 'chapter 4 verse 30 Θ', 'text Ω'])('classifies bounded scholarly references: %s', text => {
  const token = text.match(/[Α-Ωα-ω]/u)!;
  const classified = classifyForeignNarrationToken(token[0], text, token.index!, token.index! + 1);
  expect(classified.kind).toBe('contextual_letter_reference');
  expect(getKokoroPronunciationCompatibilityErrors(classified.pronunciation)).toEqual([]);
});
test.each(['θ', 'θρόνος', 'μορφη', 'περι', 'μου', 'שָׁלוֹם', 'α\u0313νεμος'])('keeps ordinary foreign letters/words lexical: %s', text => {
  expect(classifyForeignNarrationToken(text, text, 0, text.length).kind).toBe('lexical_word');
});
test('does not borrow context from a distant occurrence or infer a Greek name for other scripts', () => {
  const text = 'The Θ edition. ' + 'Unrelated prose. '.repeat(30) + 'θ';
  expect(classifyForeignNarrationToken('θ', text, text.length - 1, text.length).kind).toBe('lexical_word');
  for (const word of ['A', 'B', 'א']) {
    const classification = classifyForeignNarrationToken(word, `manuscript ${word}`, 11, 12);
    expect(classification.kind).toBe('contextual_letter_reference');
    expect(classification.pronunciation).toBeUndefined();
  }
  expect(classifyForeignNarrationToken('кардиа', 'кардиа', 0, 6).kind).toBe('source_damaged');
});

test.each(['ኵሎ', 'ኅቡኣተ', 'ጥበቦሙ', 'አ'])('classifies Ethiopic %s lexically without Greek letter conventions', word => {
  const text = `the ${word} edition`;
  expect(containsForeignLexicalLetter(word)).toBe(true);
  expect(classifyForeignNarrationToken(word, text, 4, 4 + word.length)).toMatchObject({ kind: 'lexical_word', script: 'Ethiopic' });
  expect(classifyForeignNarrationToken(word, text, 4, 4 + word.length).pronunciation).toBeUndefined();
});
test.each(['፠', '፡', '።', '፣', '፤', '፥', '፦', '፧', '፨', '\u135d', '\u135e', '\u135f'])('Ethiopic punctuation/combining marks are nonlexical: %s', character => {
  expect(containsForeignLexicalLetter(character)).toBe(false);
  expect(classifyForeignNarrationToken(character, character, 0, character.length).kind).toBe('punctuation');
});
