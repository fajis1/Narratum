import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({ getAudiobookObjectBuffer: (...args: unknown[]) => mocks.read(...args) }));
import { assertStoredPronunciationRepair } from '@/lib/server/audiobooks/pronunciation-repair-validation';

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
