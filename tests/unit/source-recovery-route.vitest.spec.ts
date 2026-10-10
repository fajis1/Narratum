import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SourceRecoveryAnalysis } from '@/types/source-recovery';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), owned: vi.fn(), read: vi.fn(), save: vi.fn(), propose: vi.fn(), render: vi.fn(), dictionary: vi.fn(), profiles: vi.fn(), profile: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: mocks.auth }));
vi.mock('@/lib/server/smart-audio/source-recovery-store', () => ({ requireOwnedPdf: mocks.owned, readSourceRecovery: mocks.read,
  saveSourceRecovery: mocks.save, SourceRecoveryConflict: class SourceRecoveryConflict extends Error {} }));
vi.mock('@/lib/server/smart-audio/source-recovery-proposals', () => ({ proposeSourceRecovery: mocks.propose, renderRecoveryPages: mocks.render,
  recoveryDictionary: mocks.dictionary, validateRecoveredSurface: (value: string) => {
    if (!/^[\p{L}\p{M}]+$/u.test(value)) throw new Error('Invalid word'); return value;
  } }));
vi.mock('@/lib/server/smart-audio-profiles', () => ({ readSmartAudioProfilesDocument: mocks.profiles, findSmartAudioProfileById: mocks.profile }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ value: { 'καταργέω': ['/katɑrɡeo/'] } }] }) }) }) } }));
import { GET, POST } from '@/app/api/documents/source-recovery/route';
function analysis(): SourceRecoveryAnalysis {
  return { schemaVersion: 1, documentId: 'pdf', revision: 3, extractionVersion: 13, scannedAt: 1, diagnostics: [], occurrences: [{
    id: 'one', groupId: 'group', surface: 'xatagyéw', pdfPage: 1, pageSourceStart: 9, before: 'word ', after: ' means', context: 'word xatagyéw means', reasons: ['OCR'], status: 'proposed',
    proposal: { correctedSurface: 'καταργέω', lemma: 'καταργέω', language: 'koine_greek', explanation: 'candidate', dictionary: null, pronunciation: '/katɑrɡeo/', pronunciationReference: { scope: 'global', term: 'καταργέω' } },
  }] };
}
const request = (body: object) => new NextRequest('http://localhost/api/documents/source-recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documentId: 'pdf', revision: 3, occurrenceId: 'one', ...body }) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ userId: 'owner' }); mocks.owned.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue(analysis()); mocks.save.mockResolvedValue(undefined); mocks.dictionary.mockResolvedValue(null);
  mocks.profiles.mockResolvedValue({ selectedProfileId: 'profile' }); mocks.profile.mockReturnValue({ geminiApiKey: 'fixture' });
  mocks.propose.mockImplementation(({ analysis: input }: { analysis: SourceRecoveryAnalysis }) => ({ ...input, revision: input.revision + 1 }));
});
test('rejects unauthorized access before loading document evidence', async () => {
  mocks.auth.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
  expect((await POST(request({ action: 'approve' }))).status).toBe(401);
  expect(mocks.owned).not.toHaveBeenCalled();
});
test('checks PDF ownership before reading analysis or rendering a page', async () => {
  mocks.owned.mockRejectedValue(new Error('PDF not found'));
  expect((await GET(new NextRequest('http://localhost/api/documents/source-recovery?documentId=pdf&page=1'))).status).toBe(404);
  expect(mocks.render).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  expect((await POST(request({ action: 'propose', groupId: 'group' }))).status).toBe(404);
  expect(mocks.propose).not.toHaveBeenCalled();
});
test('rejects stale review decisions and requires explicit page verification', async () => {
  expect((await POST(request({ action: 'approve', revision: 2, sourceVerified: true }))).status).toBe(409);
  expect((await POST(request({ action: 'approve', sourceVerified: false }))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});
test('invalidated anchors cannot be reapproved or reset into another automatic analysis', async () => {
  const current = analysis(); current.occurrences[0].anchorInvalidated = true;
  mocks.read.mockResolvedValue(current);
  expect((await POST(request({ action: 'approve', sourceVerified: true }))).status).toBe(409);
  expect((await POST(request({ action: 'reset' }))).status).toBe(409);
  expect((await POST(request({ action: 'approve_many', occurrenceIds: ['one'], sourceVerifiedOccurrenceIds: ['one'] }))).status).toBe(409);
  expect(mocks.save).not.toHaveBeenCalled();
});
test('accepts a reviewed occurrence with a pronunciation value and reference, without library writes', async () => {
  const response = await POST(request({ action: 'approve', sourceVerified: true }));
  expect(response.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith('owner', expect.objectContaining({ revision: 4, occurrences: [expect.objectContaining({ status: 'approved', proposal: expect.objectContaining({ correctedSurface: 'καταργέω', pronunciation: '/katɑrɡeo/', pronunciationReference: { scope: 'global', term: 'καταργέω' } }) })] }), 3);
});
test('bulk approval is atomic and changes only explicitly selected proposed occurrences', async () => {
  const initial = analysis();
  initial.occurrences.push({ ...initial.occurrences[0], id: 'two', pageSourceStart: 20, pdfPage: 2 });
  mocks.read.mockResolvedValue(initial);
  const response = await POST(request({ action: 'approve_many', occurrenceIds: ['one'], sourceVerifiedOccurrenceIds: ['one'] }));
  expect(response.status).toBe(200);
  const saved = mocks.save.mock.calls[0][1] as SourceRecoveryAnalysis;
  expect(saved.revision).toBe(4);
  expect(saved.occurrences.map((item) => [item.id, item.status])).toEqual([['one', 'approved'], ['two', 'proposed']]);
  expect(mocks.save).toHaveBeenCalledWith('owner', expect.anything(), 3);
});
test('bulk approval rejects unverified, duplicate, stale, and non-proposed selections', async () => {
  expect((await POST(request({ action: 'approve_many', occurrenceIds: ['one'], sourceVerifiedOccurrenceIds: [] }))).status).toBe(400);
  expect((await POST(request({ action: 'approve_many', occurrenceIds: ['one', 'one'], sourceVerifiedOccurrenceIds: ['one'] }))).status).toBe(400);
  expect((await POST(request({ action: 'approve_many', revision: 2, occurrenceIds: ['one'], sourceVerifiedOccurrenceIds: ['one'] }))).status).toBe(409);
  expect(mocks.save).not.toHaveBeenCalled();
});
test('editing a surface discards the old lemma, IPA, and pronunciation reference', async () => {
  const response = await POST(request({ action: 'approve', sourceVerified: true, correctedSurface: 'καταργούμενον' }));
  expect(response.status).toBe(200);
  const stored = mocks.save.mock.calls[0][1].occurrences[0].proposal;
  expect(stored).toMatchObject({ correctedSurface: 'καταργούμενον', lemma: null, pronunciation: null, pronunciationReference: null });
  expect(mocks.dictionary).toHaveBeenCalledWith('καταργούμενον', 'koine_greek');
});
test('rejects malformed source replacement and incompatible pronunciation', async () => {
  expect((await POST(request({ action: 'approve', sourceVerified: true, correctedSurface: '<word>' }))).status).toBe(400);
  expect((await POST(request({ action: 'approve', sourceVerified: true, pronunciation: 'garbage' }))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
});
test('keeps provider proposals unapproved and persists their diagnostics', async () => {
  const response = await POST(request({ action: 'propose', groupId: 'group' }));
  expect(response.status).toBe(200);
  expect(mocks.propose).toHaveBeenCalledWith(expect.objectContaining({ groupId: 'group', globalPronunciations: { 'καταργέω': '/katɑrɡeo/' } }));
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save.mock.calls[0][1]).toMatchObject({ revision: 4, recoveryRun: { status: 'paused' } });
  expect(mocks.save.mock.calls[1][1]).toMatchObject({ revision: 5, occurrences: [expect.objectContaining({ status: 'proposed' })] });
  expect(mocks.save.mock.calls[1][2]).toBe(4);
});
test('a provider outage records a resumable failure without counting a completed analysis batch', async () => {
  mocks.propose.mockImplementationOnce(({ analysis: input }: { analysis: SourceRecoveryAnalysis }) => ({
    ...input, revision: input.revision + 1,
    diagnostics: [{ at: 2, groupId: 'group', attempted: true, outcome: 'provider_error', httpStatus: 503, message: 'Retry later.' }],
  }));
  const response = await POST(request({ action: 'propose', groupId: 'group' }));
  expect(response.status).toBe(200);
  expect(mocks.save.mock.calls[1][1]).toMatchObject({ recoveryRun: { status: 'provider_unavailable', batchesCompleted: 0 } });
});
test('rejection and reset remove an occurrence from accepted decisions', async () => {
  expect((await POST(request({ action: 'reject' }))).status).toBe(200);
  expect(mocks.save.mock.calls[0][1].occurrences[0].status).toBe('rejected');
  expect((await POST(request({ action: 'reset' }))).status).toBe(200);
  expect(mocks.save.mock.calls[1][1].occurrences[0]).not.toHaveProperty('proposal');
});

test('GET exposes selected profile and effective model configuration without credentials', async () => {
  mocks.profile.mockReturnValue({ id: 'profile', name: 'Scholar', aiModel: 'gemini-3.8-flash', geminiApiKey: 'secret-primary', backupGeminiApiKey: 'secret-backup' });
  const response = await GET(new NextRequest('http://localhost/api/documents/source-recovery?documentId=pdf'));
  const data = await response.json();
  expect(mocks.profile).toHaveBeenCalledWith({ selectedProfileId: 'profile' }, 'profile');
  expect(data.configuration).toEqual({ profileId: 'profile', profileName: 'Scholar', model: 'gemini-3.8-flash',
    fallbackModels: ['gemini-3.7-flash', 'gemini-3.6-flash'], primaryKeyConfigured: true, backupKeyConfigured: true, automaticBackupFailover: true });
  expect(JSON.stringify(data)).not.toContain('secret-');
});

test('validates OCR-only model overrides and resolves credentials from the saved selected profile', async () => {
  mocks.profile.mockReturnValue({ id: 'profile', name: 'Scholar', aiModel: 'gemini-3.8-flash', geminiApiKey: 'saved-primary', backupGeminiApiKey: 'saved-backup' });
  expect((await POST(request({ action: 'propose', groupId: 'group', ocrModel: '../bad', ocrFallbackModels: [] }))).status).toBe(400);
  expect((await POST(request({ action: 'propose', groupId: 'group', ocrFallbackModels: ['bad'] }))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
  expect((await POST(request({ action: 'propose', groupId: 'group', ocrModel: 'gemini-3.7-flash',
    ocrFallbackModels: ['gemini-3.6-flash'], useBackupKey: true, geminiApiKey: 'untrusted-browser-key' }))).status).toBe(200);
  expect(mocks.propose).toHaveBeenCalledWith(expect.objectContaining({ useBackupKey: true, signal: expect.any(AbortSignal),
    profile: expect.objectContaining({ geminiApiKey: 'saved-primary', backupGeminiApiKey: 'saved-backup', pronunciationAiModel: 'gemini-3.7-flash', pronunciationAiModelFallbacks: ['gemini-3.6-flash'] }) }));
});

test('rejects backup override without a saved backup and supports backup-only saved profiles', async () => {
  expect((await POST(request({ action: 'propose', groupId: 'group', useBackupKey: true }))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
  mocks.profile.mockReturnValue({ id: 'profile', name: 'Backup only', backupGeminiApiKey: 'saved-backup' });
  expect((await POST(request({ action: 'propose', groupId: 'group' }))).status).toBe(200);
});

test('persists a provider-directed cooldown and prevents premature requests after restart', async () => {
  mocks.propose.mockImplementationOnce(({ analysis: input }: { analysis: SourceRecoveryAnalysis }) => ({ ...input, revision: input.revision + 1,
    diagnostics: [{ at: Date.now(), groupId: 'group', attempted: true, outcome: 'provider_error', httpStatus: 429, retryable: true, retryAfterMs: 600_000, usedBackup: false, message: 'Rate limited.' }] }));
  const before = Date.now();
  expect((await POST(request({ action: 'propose', groupId: 'group' }))).status).toBe(200);
  const saved = mocks.save.mock.calls[1][1] as SourceRecoveryAnalysis;
  expect(saved.recoveryRun?.nextAttemptAt).toBeGreaterThanOrEqual(before + 600_000);
  mocks.read.mockResolvedValue(saved); mocks.propose.mockClear(); mocks.save.mockClear();
  expect((await POST(request({ action: 'propose', groupId: 'group', revision: saved.revision }))).status).toBe(429);
  expect(mocks.propose).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});

test.each(['renderer_error', 'configuration_error', 'validation_rejected', 'cancelled'] as const)('%s is not saved as Gemini temporarily unavailable', async outcome => {
  mocks.propose.mockImplementationOnce(({ analysis: input }: { analysis: SourceRecoveryAnalysis }) => ({ ...input, revision: input.revision + 1,
    diagnostics: [{ at: Date.now(), groupId: 'group', attempted: false, outcome, message: 'Stage-specific failure.' }] }));
  expect((await POST(request({ action: 'propose', groupId: 'group' }))).status).toBe(200);
  expect(mocks.save.mock.calls[1][1].recoveryRun).toMatchObject({ status: outcome === 'cancelled' ? 'cancelled' : 'failed', batchesCompleted: 0 });
  expect(mocks.save.mock.calls[1][1].recoveryRun.nextAttemptAt).toBeUndefined();
});

test('an explicit independent backup may bypass a primary cooldown, but not its own saved cooldown', async () => {
  mocks.profile.mockReturnValue({ geminiApiKey: 'primary', backupGeminiApiKey: 'backup' });
  const current = analysis(); current.recoveryRun = { status: 'provider_unavailable', batchesCompleted: 0, updatedAt: 1, nextAttemptAt: Date.now() + 60_000 };
  current.diagnostics = [{ at: 1, groupId: 'group', attempted: true, outcome: 'provider_error', message: 'Unavailable', usedBackup: true }];
  mocks.read.mockResolvedValue(current);
  expect((await POST(request({ action: 'propose', groupId: 'group', useBackupKey: true }))).status).toBe(429);
  current.diagnostics[0].usedBackup = false;
  expect((await POST(request({ action: 'propose', groupId: 'group', useBackupKey: true }))).status).toBe(200);
});
