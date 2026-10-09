import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteResults: [] as unknown[][],
  deleteSourceRecovery: vi.fn(async () => undefined),
  deleteDocumentTtsSegmentCache: vi.fn(async () => undefined),
}));

function resultBuilder(result: unknown[]) {
  return {
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

vi.mock('@/db', () => {
  const database = {
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: () => resultBuilder(mocks.deleteResults.shift() ?? []),
      })),
    })),
  };
  return { db: database };
});

vi.mock('@/lib/server/smart-audio/source-recovery-store', () => ({ deleteSourceRecovery: mocks.deleteSourceRecovery }));

vi.mock('@/lib/server/tts/segments-cache', () => ({
  deleteDocumentTtsSegmentCache: mocks.deleteDocumentTtsSegmentCache,
}));

vi.mock('@/lib/server/logger', () => ({
  hashForLog: () => 'hash',
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/server/errors/logging', () => ({ logDegraded: vi.fn() }));

import { deleteOwnedDocument } from '../../src/lib/server/documents/delete-owned';

describe('owned document cleanup', () => {
  beforeEach(() => {
    mocks.deleteResults = [];
    mocks.deleteSourceRecovery.mockReset();
    mocks.deleteSourceRecovery.mockResolvedValue(undefined);
    mocks.deleteDocumentTtsSegmentCache.mockReset();
    mocks.deleteDocumentTtsSegmentCache.mockResolvedValue(undefined);
  });

  test('removes the ownership row and cleans the per-user TTS cache', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    })).resolves.toBe(true);

    expect(mocks.deleteSourceRecovery).toHaveBeenCalledWith('user-1', 'doc-1');
    expect(mocks.deleteDocumentTtsSegmentCache).toHaveBeenCalledOnce();
  });

  test('returns false and skips cleanup when no row was owned', async () => {
    mocks.deleteResults = [[]];

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    })).resolves.toBe(false);

    expect(mocks.deleteSourceRecovery).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentTtsSegmentCache).not.toHaveBeenCalled();
  });

  test('still succeeds if TTS cache cleanup fails (best effort)', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];
    mocks.deleteDocumentTtsSegmentCache.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    })).resolves.toBe(true);
  });
});
