import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { DramaDirectorSegment } from '@/lib/shared/drama-director-schema';
import type { SmartAudioCharacterMap } from '@/types/document-settings';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), rows: [] as unknown[][], get: vi.fn(), put: vi.fn(), generate: vi.fn(), profiles: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.auth }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.rows.shift() || [] }) }) }) } }));
vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  getAudiobookObjectBuffer: mocks.get, putAudiobookObject: mocks.put,
  isMissingBlobError: (error: unknown) => error instanceof Error && error.message === 'missing',
}));
vi.mock('@/lib/server/audiobooks/cloud-drama', () => ({ generateCloudDramaAudiobook: mocks.generate }));
vi.mock('@/lib/server/smart-audio-profiles', () => ({
  readSmartAudioProfilesDocument: mocks.profiles,
  findSmartAudioProfileById: (profiles: Array<{ id: string }>, id: string) => profiles.find((profile) => profile.id === id),
}));

import { GET, POST, PUT } from '@/app/api/audiobook/drama-segments/route';
import { saveDramaSpeakerReview, validateSavedDramaReview, dramaCastHash, loadReusableDramaReview } from '@/lib/server/audiobooks/drama-speaker-review';
import { getMatchingDramaSpeakerReview } from '@/lib/shared/drama-speaker-review';
import { normalizeDramaSpeechSettings } from '@/lib/shared/drama-speech-settings';

const segment: DramaDirectorSegment = {
  speaker: 'Bethany', utteranceType: 'spoken-dialogue', text: 'Understood.', sceneContext: 'Ali waits for a reply.', omit_from_audio: false,
  performance: { primaryEmotion: 'calm', secondaryEmotions: [], socialIntent: 'informing', delivery: ['natural'], pace: 'normal', energy: 'low', intensity: 'low', tags: [] },
};
const map: SmartAudioCharacterMap = {
  schemaVersion: 1, status: 'complete', scannedAt: 1, entries: {
    Bethany: { name: 'Bethany', voiceId: 'Kore', description: '', sampleText: '' },
    Ali: { name: 'Ali', voiceId: 'Kore', description: '', sampleText: '' },
  },
};
const profile = { id: 'drama', workerMode: 'drama-gemini-tts', geminiApiKey: 'test-key' };
const request = () => new NextRequest('http://localhost/api/audiobook/drama-segments', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: 'book', chapterIndex: 0, profileId: 'drama' }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ userId: 'owner' });
  mocks.rows = [[{ id: 'book' }], [{ dataJson: JSON.stringify({ smartAudioCharacters: map }) }], [], [], [{ dataJson: JSON.stringify({ smartAudioCharacters: map }) }]];
  mocks.profiles.mockResolvedValue([profile]);
  mocks.get.mockImplementation(async (_book, _user, file) => {
    if (file.endsWith('drama_segments.json')) throw new Error('missing');
    return Buffer.from(segment.text);
  });
  mocks.put.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({ segments: [segment], audioBuffer: Buffer.alloc(0), reviewFlags: [] });
});

describe('Gemini Drama speaker review', () => {
  it('persists ordered turns with distinct character names even when voices are shared', async () => {
    const turns = [segment, { ...segment, speaker: 'Ali', text: 'As my lady requests.' }];
    const sourceText = turns.map((turn) => turn.text).join('');
    const review = await saveDramaSpeakerReview({ bookId: 'book', userId: 'owner', chapterIndex: 0,
      profileId: 'drama', sourceText, characterMap: map, segments: turns, complete: true });
    expect(mocks.put.mock.calls[0][2]).toBe('0001__drama_segments.json');
    expect(review.segments.map((turn) => [turn.speaker, turn.voiceId])).toEqual([['Bethany', 'Kore'], ['Ali', 'Kore']]);
    expect(review.segments.map((turn) => turn.text).join('')).toBe(sourceText);
    expect(getMatchingDramaSpeakerReview(review, sourceText)).toBe(review);
    expect(getMatchingDramaSpeakerReview(review, sourceText + 'Changed.')).toBeNull();
    expect(JSON.stringify(review)).not.toContain(profile.geminiApiKey);
  });

  it('prepares old chapter assignments from saved text without recording audio', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ directionOnly: true, cleanedText: segment.text }));
    const { review } = await response.json();
    expect(review.preparedOnly).toBe(true);
    expect(review.segments[0].speaker).toBe('Bethany');
    expect(JSON.stringify(review)).not.toContain(profile.geminiApiKey);
  });

  it('falls back to rejected text for failed chapters', async () => {
    mocks.get.mockRejectedValueOnce(new Error('missing')).mockResolvedValueOnce(Buffer.from(segment.text));
    expect((await POST(request())).status).toBe(200);
    expect(mocks.get.mock.calls.slice(0, 2).map((call) => call[2])).toEqual(['0001__text.txt', '0001__rejected.txt']);
  });

  it('does not contact Gemini or storage for a book owned by someone else', async () => {
    mocks.rows = [[]];
    expect((await POST(request())).status).toBe(404);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('returns an explicit absent-review state for historical chapters', async () => {
    mocks.get.mockRejectedValue(new Error('missing'));
    const response = await GET(new NextRequest('http://localhost/api/audiobook/drama-segments?bookId=book&chapterIndex=0'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ review: null });
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('loads persisted assignments without calling Gemini', async () => {
    mocks.get.mockResolvedValue(Buffer.from(JSON.stringify({ segments: [segment] })));
    const response = await GET(new NextRequest('http://localhost/api/audiobook/drama-segments?bookId=book&chapterIndex=0'));
    expect((await response.json()).review.segments[0].speaker).toBe('Bethany');
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  const saved = () => ({ schemaVersion: 1 as const, chapterIndex: 0, profileId: 'drama', sourceText: segment.text,
    complete: true, preparedOnly: true, revision: 'revision-1', castHash: dramaCastHash(map), segments: [{ ...segment, voiceId: 'Kore' }] });

  it.each(['revision', 'text', 'cast', 'running'])('does not overwrite changes to %s while the Director prepares turns', async conflict => {
    let generated = false;
    mocks.generate.mockImplementation(async () => { generated = true; return { segments: [segment] }; });
    mocks.get.mockImplementation(async (_book, _user, file) => {
      if (file.endsWith('drama_segments.json')) {
        if (generated && conflict === 'revision') return Buffer.from(JSON.stringify(saved()));
        throw new Error('missing');
      }
      return Buffer.from(generated && conflict === 'text' ? 'Changed.' : segment.text);
    });
    if (conflict === 'running') mocks.rows[3] = [{ id: 'job' }];
    if (conflict === 'cast') mocks.rows[4] = [{ dataJson: JSON.stringify({ smartAudioCharacters: { ...map, entries: { ...map.entries, Ali: { ...map.entries.Ali, voiceId: 'Puck' } } } }) }];
    expect((await POST(request())).status).toBe(409);
    expect(mocks.put).not.toHaveBeenCalled();
  });
  const correction = (patch: Record<string, unknown> = {}) => new NextRequest('http://localhost/api/audiobook/drama-segments', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookId: 'book', chapterIndex: 0,
      revision: 'revision-1', turns: [{ index: 0, speaker: 'Ali', utteranceType: 'squad-link' }],
      speechTypes: normalizeDramaSpeechSettings({ 'squad-link': { effect: 'cb-radio', strength: 50 } }), ...patch }),
  });
  function correctionStorage() {
    const review = saved();
    mocks.rows = [[{ id: 'book' }], [], [{ dataJson: JSON.stringify({ smartAudioCharacters: map }) }], []];
    mocks.get.mockImplementation(async (_book, _user, file) => Buffer.from(file.endsWith('drama_segments.json') ? JSON.stringify(review) : segment.text));
    return review;
  }

  it('saves user classifications and effects without synthesis, source edits or audio writes', async () => {
    correctionStorage();
    const response = await PUT(correction());
    expect(response.status).toBe(200);
    const { review } = await response.json();
    expect(review.segments[0]).toMatchObject({ speaker: 'Ali', utteranceType: 'squad-link', voiceId: 'Kore', text: segment.text });
    expect(review.reviewedAt).toBeGreaterThan(0); expect(review.revision).not.toBe('revision-1');
    expect(review.speechTypes['squad-link'].effect).toBe('cb-radio');
    expect(validateSavedDramaReview(review, { sourceText: segment.text, characterMap: map, profileId: 'drama' })[0].speaker).toBe('Ali');
    expect(mocks.put.mock.calls.map(call => call[2])).toEqual(['0001__drama_segments.json']);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it.each(['revision', 'text', 'cast', 'running', 'speaker', 'speech-type'])('refuses %s conflicts or invalid choices before any write', async conflict => {
    correctionStorage();
    let patch: Record<string, unknown> = {};
    if (conflict === 'revision') patch = { revision: 'stale' };
    if (conflict === 'text') mocks.get.mockImplementation(async (_book, _user, file) => Buffer.from(file.endsWith('drama_segments.json') ? JSON.stringify(saved()) : 'Changed.'));
    if (conflict === 'cast') mocks.rows[2] = [{ dataJson: JSON.stringify({ smartAudioCharacters: { ...map, entries: { ...map.entries, Ali: { ...map.entries.Ali, voiceId: 'Puck' } } } }) }];
    if (conflict === 'running') mocks.rows[1] = [{ id: 'job' }];
    if (conflict === 'speaker' || conflict === 'speech-type') patch = { turns: [{ index: 0, speaker: conflict === 'speaker' ? 'Unknown' : 'Ali', utteranceType: conflict === 'speech-type' ? 'invented' : 'squad-link' }] };
    expect((await PUT(correction(patch))).status).toBe(['speaker', 'speech-type'].includes(conflict) ? 400 : 409);
    expect(mocks.put).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('does not allow uploaded turn text or performance to replace authoritative direction', async () => {
    correctionStorage();
    const response = await PUT(correction({ turns: [{ index: 0, speaker: 'Ali', utteranceType: 'internal-thought', text: 'Replacement.', omit_from_audio: true, performance: { primaryEmotion: 'invented' }, voiceId: 'Unknown' }] }));
    expect(response.status).toBe(200);
    const { review } = await response.json();
    expect(review.segments[0]).toMatchObject({ text: segment.text, omit_from_audio: false, performance: segment.performance, voiceId: 'Kore' });
  });

  it('saves a chapter-title classification with the selected title voice, retaining the cast', async () => {
    correctionStorage();
    const response = await PUT(correction({ turns: [{ index: 0, speaker: 'Ali', utteranceType: 'chapter-title' }], chapterTitles: { enabled: true, voiceId: 'Puck' } }));
    expect(response.status).toBe(200);
    const { review } = await response.json();
    expect(review.chapterTitles).toEqual({ enabled: true, voiceId: 'Puck' });
    expect(review.segments[0]).toMatchObject({ utteranceType: 'chapter-title', voiceId: 'Puck', text: segment.text });
    expect(map.entries.Ali.voiceId).toBe('Kore');
    expect(validateSavedDramaReview(review, { sourceText: segment.text, characterMap: map, profileId: 'drama' })).toHaveLength(1);
  });

  it('rejects stale explicitly reviewed direction while treating old automatic artifacts as non-reusable', async () => {
    mocks.get.mockResolvedValue(Buffer.from(JSON.stringify({ ...saved(), reviewedAt: 1 })));
    await expect(loadReusableDramaReview({ bookId: 'book', userId: 'owner', chapterIndex: 0, profileId: 'drama', sourceText: 'Changed.', characterMap: map })).rejects.toThrow(/no longer matches/);
    mocks.get.mockResolvedValue(Buffer.from(JSON.stringify({ ...saved(), castHash: undefined })));
    expect(await loadReusableDramaReview({ bookId: 'book', userId: 'owner', chapterIndex: 0, profileId: 'drama', sourceText: segment.text, characterMap: map })).toBeNull();
  });
});
