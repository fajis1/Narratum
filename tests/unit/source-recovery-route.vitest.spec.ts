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
  mocks.propose.mockResolvedValue({ ...analysis(), revision: 4 });
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
test('accepts a reviewed occurrence with a pronunciation value and reference, without library writes', async () => {
  const response = await POST(request({ action: 'approve', sourceVerified: true }));
  expect(response.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith('owner', expect.objectContaining({ revision: 4, occurrences: [expect.objectContaining({ status: 'approved', proposal: expect.objectContaining({ correctedSurface: 'καταργέω', pronunciation: '/katɑrɡeo/', pronunciationReference: { scope: 'global', term: 'καταργέω' } }) })] }), 3);
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
  expect(mocks.save.mock.calls[0][1].occurrences[0].status).toBe('proposed');
});
test('rejection and reset remove an occurrence from accepted decisions', async () => {
  expect((await POST(request({ action: 'reject' }))).status).toBe(200);
  expect(mocks.save.mock.calls[0][1].occurrences[0].status).toBe('rejected');
  expect((await POST(request({ action: 'reset' }))).status).toBe(200);
  expect(mocks.save.mock.calls[1][1].occurrences[0]).not.toHaveProperty('proposal');
});
