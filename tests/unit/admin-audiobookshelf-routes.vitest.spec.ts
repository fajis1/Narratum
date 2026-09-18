import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  recordSupportAudit: vi.fn(),
  uploadBookToAudiobookshelf: vi.fn(),
  matchAudiobookshelfCandidateWithGemini: vi.fn(),
  searchAudiobookshelfCandidates: vi.fn(),
  resolveAudiobookshelfConfig: vi.fn(),
  inferDocumentMetadataWithGemini: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: mocks.requireAuthContext,
}));

vi.mock('@/lib/server/admin/support', () => ({
  recordSupportAudit: mocks.recordSupportAudit,
}));

vi.mock('@/lib/server/audiobooks/audiobookshelf', () => ({
  uploadBookToAudiobookshelf: mocks.uploadBookToAudiobookshelf,
  matchAudiobookshelfCandidateWithGemini: mocks.matchAudiobookshelfCandidateWithGemini,
  searchAudiobookshelfCandidates: mocks.searchAudiobookshelfCandidates,
  resolveAudiobookshelfConfig: mocks.resolveAudiobookshelfConfig,
  fetchAudiobookshelfLibraries: vi.fn().mockResolvedValue([{ id: 'lib-1', name: 'Audiobooks' }]),
}));

vi.mock('@/lib/server/audiobooks/metadata-inference', () => ({
  inferDocumentMetadataWithGemini: mocks.inferDocumentMetadataWithGemini,
}));

vi.mock('@/db', () => ({
  db: {
    select: mocks.dbSelect,
  },
}));

describe('admin Audiobookshelf routes delegation and audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.resolveAudiobookshelfConfig.mockResolvedValue({
      isConfigured: true,
      url: 'http://abs.test:13378',
      token: 'test-token',
      libraryId: 'lib-1',
      folderId: 'folder-1',
    });

    mocks.uploadBookToAudiobookshelf.mockResolvedValue({
      success: true,
      title: 'The Way of Kings',
      unified: true,
    });

    mocks.recordSupportAudit.mockResolvedValue({ id: 'audit-1' });

    mocks.inferDocumentMetadataWithGemini.mockResolvedValue({
      title: 'The Way of Kings',
      author: 'Brandon Sanderson',
      series: 'The Stormlight Archive',
      seriesIndex: '1',
      subtitle: null,
    });
  });

  describe('POST /api/audiobook/audiobookshelf', () => {
    test('admin can upload on behalf of target user and records support audit', async () => {
      mocks.requireAuthContext.mockResolvedValue({
        userId: 'admin-user-id',
        user: { id: 'admin-user-id', isAdmin: true },
      });

      const { POST } = await import('../../src/app/api/audiobook/audiobookshelf/route');
      const req = new NextRequest('http://localhost/api/audiobook/audiobookshelf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: 'book-123',
          userId: 'target-user-456',
          title: 'The Way of Kings',
          author: 'Brandon Sanderson',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mocks.uploadBookToAudiobookshelf).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 'book-123',
          userId: 'target-user-456',
          title: 'The Way of Kings',
        }),
      );

      expect(mocks.recordSupportAudit).toHaveBeenCalledWith({
        adminUserId: 'admin-user-id',
        targetUserId: 'target-user-456',
        action: 'audiobookshelf_upload',
        resourceId: 'book-123',
        note: 'Exported audiobook "The Way of Kings" to Audiobookshelf (merged into existing card)',
      });
    });

    test('non-admin cannot forge userId parameter', async () => {
      mocks.requireAuthContext.mockResolvedValue({
        userId: 'regular-user-id',
        user: { id: 'regular-user-id', isAdmin: false },
      });

      const { POST } = await import('../../src/app/api/audiobook/audiobookshelf/route');
      const req = new NextRequest('http://localhost/api/audiobook/audiobookshelf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: 'book-123',
          userId: 'target-user-456', // attempt to forge
          title: 'My Book',
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);

      // Must use the caller's actual userId, ignoring the forged one
      expect(mocks.uploadBookToAudiobookshelf).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 'book-123',
          userId: 'regular-user-id',
        }),
      );

      // Support audit must NOT be called for regular user uploads
      expect(mocks.recordSupportAudit).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/audiobook/metadata/infer-title', () => {
    test('admin can infer title on behalf of target user', async () => {
      mocks.requireAuthContext.mockResolvedValue({
        userId: 'admin-user-id',
        user: { id: 'admin-user-id', isAdmin: true },
      });

      const { GET } = await import('../../src/app/api/audiobook/metadata/infer-title/route');
      const req = new NextRequest(
        'http://localhost/api/audiobook/metadata/infer-title?bookId=book-123&userId=target-user-456',
      );

      const res = await GET(req);
      expect(res.status).toBe(200);

      expect(mocks.inferDocumentMetadataWithGemini).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 'book-123',
          userId: 'target-user-456',
        }),
      );
    });

    test('non-admin infer-title uses caller userId even if userId param passed', async () => {
      mocks.requireAuthContext.mockResolvedValue({
        userId: 'regular-user-id',
        user: { id: 'regular-user-id', isAdmin: false },
      });

      const { GET } = await import('../../src/app/api/audiobook/metadata/infer-title/route');
      const req = new NextRequest(
        'http://localhost/api/audiobook/metadata/infer-title?bookId=book-123&userId=target-user-456',
      );

      const res = await GET(req);
      expect(res.status).toBe(200);

      expect(mocks.inferDocumentMetadataWithGemini).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 'book-123',
          userId: 'regular-user-id',
        }),
      );
    });
  });
});
