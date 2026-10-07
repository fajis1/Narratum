import { beforeEach, expect, test, vi } from 'vitest';
import { approvedPronunciationCandidates } from '@/lib/shared/remember-approved-pronunciations';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
const mocks = vi.hoisted(() => ({ reads: [] as unknown[][], update: vi.fn(), insert: vi.fn(), idle: vi.fn() }));
vi.mock('@/lib/server/audiobooks/pronunciation-repairs', () => ({ assertPronunciationBookIdle: (...args: unknown[]) => mocks.idle(...args) }));
vi.mock('@/db', () => ({ db: {
  select: () => {
    const rows = mocks.reads.shift() || [];
    const chain = { from: () => chain, innerJoin: () => chain, where: () => chain, orderBy: async () => rows, limit: async () => rows };
    return chain;
  },
  update: () => ({ set: (value: unknown) => ({ where: () => ({ returning: () => mocks.update(value) }) }) }),
  insert: () => ({ values: (value: unknown) => ({ onConflictDoNothing: () => ({ returning: () => mocks.insert(value) }) }) }),
} }));
import { rememberApprovedPronunciations } from '@/lib/server/audiobooks/remember-approved-pronunciations';
const approved = { chapterIndex: 0, decision: 'approved', profileId: 'profile', previousText: 'The λόγος remains.', proposedText: 'The [λόγος](/lɒɡɒs/) remains.' };
beforeEach(() => { vi.clearAllMocks(); mocks.reads = []; mocks.update.mockResolvedValue([{ id: 'book' }]); mocks.insert.mockResolvedValue([{ id: 'book' }]); });

test('extracts changed complete words and skips contextual forms and reconstructed labels', () => {
  expect(approvedPronunciationCandidates([approved]).entries).toEqual({ 'λόγος': '/lɒɡɒs/' });
  for (const [previousText, proposedText] of [
    ['δ᾽', '[δ᾽](/dɛ/)'], ['-φροσύνη', '[-φροσύνη](/frɒsuneɪ/)'],
    ['Job', '[Job](!/dʒoʊb/)'], ['θε(οῦ)', '[θε(οῦ)](/θɛu/)'],
    ['oἷς', '[οἷς](/hɔɪs/)'], ['λόγος', '[λόγος](/bad split/)'],
  ]) expect(approvedPronunciationCandidates([{ previousText, proposedText }]).entries).toEqual({});
  expect(approvedPronunciationCandidates([{ previousText: approved.proposedText, proposedText: approved.proposedText }]).entries).toEqual({});
});

test('conflicting approved pronunciations are not learned', () => {
  expect(approvedPronunciationCandidates([approved, { ...approved, proposedText: 'The [λόγος](/loʊɡoʊs/) remains.' }]).entries).toEqual({});
});

test('remembers only latest approved chapters, preserving document settings and definition status', async () => {
  mocks.reads.push([approved, { ...approved, decision: 'pending' }, { ...approved, chapterIndex: 1, decision: 'pending' }], [{ dataJson: JSON.stringify({ language: 'fr', fontSize: 19 }) }]);
  expect(await rememberApprovedPronunciations('book', 'owner')).toMatchObject({ saved: 1 });
  expect(mocks.idle).toHaveBeenCalledWith('book', 'owner');
  const saved = JSON.parse(mocks.update.mock.calls[0][0].dataJson);
  expect(saved).toMatchObject({ language: 'fr', fontSize: 19, smartAudioLexicon: { profileId: 'profile', status: 'partial', definitionScanComplete: false,
    entries: { 'λόγος': { pronunciation: '/lɒɡɒs/', approvedRepair: true, definition: null } } } });
  expect(mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, saved).smartAudioLexicon?.entries['λόγος'].approvedRepair).toBe(true);
});

test('rechecks concurrent edits and leaves conflicting dictionary entries untouched', async () => {
  mocks.update.mockResolvedValueOnce([]);
  const existing = { language: 'de', smartAudioLexicon: { schemaVersion: 1, status: 'complete', definitionScanComplete: true, profileId: 'profile', pronunciationModel: 'fixture', scannedAt: 1,
    entries: { 'λόγος': { term: 'λόγος', pronunciation: '/loʊɡoʊs/', definition: 'word', language: 'koine_greek' } } } };
  mocks.reads.push([approved], [{ dataJson: '{}' }], [{ dataJson: JSON.stringify(existing) }]);
  expect(await rememberApprovedPronunciations('book', 'owner')).toMatchObject({ saved: 0, skipped: 1 });
  expect(mocks.update).toHaveBeenCalledTimes(1);
});

test('repeated remember is idempotent and preserves the existing definition', async () => {
  const settings = { smartAudioLexicon: { profileId: 'profile', entries: { 'λόγος': { term: 'λόγος', pronunciation: '/lɒɡɒs/', approvedRepair: true, definition: 'word' } } } };
  mocks.reads.push([approved], [{ dataJson: JSON.stringify(settings) }]);
  expect(await rememberApprovedPronunciations('book', 'owner')).toMatchObject({ saved: 0, alreadyKnown: 1 });
  expect(mocks.update).not.toHaveBeenCalled();
});

test('overwrites broken dictionary entries containing whitespace or malformed IPA', async () => {
  const existing = {
    smartAudioLexicon: {
      profileId: 'profile',
      entries: {
        'λόγος': { term: 'λόγος', pronunciation: '/loʊ ɡoʊs/', definition: 'word', language: 'koine_greek' },
      },
    },
  };
  mocks.reads.push([approved], [{ dataJson: JSON.stringify(existing) }]);
  expect(await rememberApprovedPronunciations('book', 'owner')).toMatchObject({ saved: 1, skipped: 0 });
  expect(mocks.update).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(mocks.update.mock.calls[0][0].dataJson);
  expect(saved.smartAudioLexicon.entries['λόγος'].pronunciation).toBe('/lɒɡɒs/');
});

test('approved contextual sigla never become reusable lexical dictionary entries', () => {
  expect(approvedPronunciationCandidates([{ previousText: 'The Θ edition and Σ manuscript.', proposedText: 'The [Θ](/θeɪtə/) edition and [Σ](/sɪɡmə/) manuscript.' }]).entries).toEqual({});
});
