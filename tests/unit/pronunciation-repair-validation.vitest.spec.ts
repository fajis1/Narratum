import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({ getAudiobookObjectBuffer: (...args: unknown[]) => mocks.read(...args) }));
import { assertStoredPronunciationRepair, hasPronunciationReviewOverride, PRONUNCIATION_REVIEW_OVERRIDE_NOTE } from '@/lib/server/audiobooks/pronunciation-repair-validation';

const input = { bookId: 'book', userId: 'owner', fileName: '0001__text.txt', previous: '[proseɪkoʊn](/proʊseɪkoʊn/)', proposed: '[προσῆκόν](/proʊseɪkoʊn/)' };
beforeEach(() => vi.clearAllMocks());

test('approval and recording wrapper requires retained source evidence for reconstruction', async () => {
  mocks.read.mockResolvedValue(Buffer.from('Source προσῆκόν.'));
  await expect(assertStoredPronunciationRepair(input)).resolves.toBeUndefined();
  expect(mocks.read).toHaveBeenCalledWith('book', 'owner', '0001__original.txt', null);
  mocks.read.mockResolvedValue(Buffer.from('No supporting word.'));
  await expect(assertStoredPronunciationRepair(input)).rejects.toThrow('English');
});

test('uses retained rejected source and never allows partial output into recording', async () => {
  mocks.read.mockResolvedValue(Buffer.from(JSON.stringify({ sourceText: 'προσῆκόν' })));
  await expect(assertStoredPronunciationRepair({ ...input, fileName: '0001__rejected.txt' })).resolves.toBeUndefined();
  expect(mocks.read).toHaveBeenCalledWith('book', 'owner', '0001__pronunciation_failure.json', null);
  await expect(assertStoredPronunciationRepair({ ...input, previous: 'τὸ θεῷ', proposed: '[τὸ](/toʊ/) θεῷ' })).rejects.toThrow('remain');
});

test('approval/recording accepts contextual letter names and preserves Hebrew punctuation', async () => {
  const previous = 'The Θ edition: [ולא](/vəloʊ/)־למדתי׃';
  const proposed = 'The [Θ](/θeɪtə/) edition: [ולא](/vəloʊ/)־[למדתי](/lɑmɑdti/)׃';
  await expect(assertStoredPronunciationRepair({ ...input, previous, proposed })).resolves.toBeUndefined();
  expect(mocks.read).not.toHaveBeenCalled();
  for (const changed of [proposed.replace('־', '-'), proposed.replace('׃', '.'), proposed.replace('למדתי', 'בינת'), proposed.replace('Θ', 'Σ')]) {
    await expect(assertStoredPronunciationRepair({ ...input, previous, proposed: changed })).rejects.toThrow();
  }
});

test('approval/recording rejects canonical Unicode relabeling but accepts the exact printed label', async () => {
  const word = 'α\u0313νεμος';
  const previous = `Read ${word}.`;
  await expect(assertStoredPronunciationRepair({ ...input, previous, proposed: `Read [${word}](/ɑnɛmoʊs/).` })).resolves.toBeUndefined();
  await expect(assertStoredPronunciationRepair({ ...input, previous, proposed: `Read [${word.normalize('NFC')}](/ɑnɛmoʊs/).` })).rejects.toThrow('source');
  expect(mocks.read).not.toHaveBeenCalled();
});


test('explicit reviewer Override accepts the production siglum proposal with remaining warnings', async () => {
  const previous = 'The Θ edition used μου in Daniel chapter 4 verse 33 Θ and 7:28 Θ. [περι](/pɛr/)';
  const proposed = 'The [Θ](/θeɪtə/) edition used [μου](/mu/) in Daniel chapter 4 verse 33 [Θ](/θeɪtə/) and 7:28 Θ. [περι](/pɛr/)';
  await expect(assertStoredPronunciationRepair({ ...input, previous, proposed })).rejects.toThrow('remain');
  await expect(assertStoredPronunciationRepair({ ...input, previous, proposed, overridePronunciationReview: true })).resolves.toBeUndefined();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(hasPronunciationReviewOverride(PRONUNCIATION_REVIEW_OVERRIDE_NOTE)).toBe(true);
  expect(hasPronunciationReviewOverride('ordinary review note')).toBe(false);
});

test('Override cannot change source characters, prose, Unicode, speaker tags or accept broken markup', async () => {
  const previous = '<voice name="af_bella">The Θ edition: ולא־למדתי׃ περι.</voice>';
  const proposed = '<voice name="af_bella">The [Θ](/θeɪtə/) edition: [ולא](/vəloʊ/)־[למדתי](/lɑmɑdti/)׃ [περι](/pɛr/).</voice>';
  await expect(assertStoredPronunciationRepair({ ...input, previous, proposed, overridePronunciationReview: true })).resolves.toBeUndefined();
  for (const changed of [proposed.replace('edition', 'translation'), proposed.replace('־', '-'), proposed.replace('׃', '.'), proposed.replace('af_bella', 'af_heart'), proposed.replace('למדתי', 'בינת'), proposed.replace('[Θ](/θeɪtə/)', '[Θ](/θeɪtə]')]) {
    await expect(assertStoredPronunciationRepair({ ...input, previous, proposed: changed, overridePronunciationReview: true })).rejects.toThrow();
  }
  const decomposed = 'α\u0313νεμος';
  await expect(assertStoredPronunciationRepair({ ...input, previous: decomposed, proposed: `[${decomposed.normalize('NFC')}](/ɑnɛmoʊs/)`, overridePronunciationReview: true })).rejects.toThrow();
});
