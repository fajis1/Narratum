import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runPostGenerationPronunciationSweep } from '@/lib/server/audiobooks/post-generation-repair';

vi.mock('@/lib/server/audiobooks/pronunciation-repairs', () => ({
  pronunciationCatalog: vi.fn(),
  readPronunciationChapter: vi.fn(),
  proposePronunciationRepair: vi.fn(),
}));
vi.mock('@/lib/shared/pronunciation-issues', () => ({
  scanPronunciationIssues: vi.fn(),
}));
vi.mock('@/lib/server/audiobooks/batch-refine-review-store', () => ({
  approveBatchRefineChange: vi.fn(),
}));
vi.mock('@/lib/server/tasks/engine', () => ({
  runTaskNow: vi.fn(),
}));
vi.mock('@/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => [{ id: 'test-change-id', decision: 'pending' }]),
        })),
      })),
    })),
  },
}));
vi.mock('@/db/schema', () => ({
  batchRefineChanges: {
    id: 'id',
    runId: 'runId',
    userId: 'userId',
    documentId: 'documentId',
    decision: 'decision',
  },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@/lib/server/logger', () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { pronunciationCatalog, readPronunciationChapter, proposePronunciationRepair } from '@/lib/server/audiobooks/pronunciation-repairs';
import { scanPronunciationIssues } from '@/lib/shared/pronunciation-issues';
import { approveBatchRefineChange } from '@/lib/server/audiobooks/batch-refine-review-store';
import { runTaskNow } from '@/lib/server/tasks/engine';

describe('runPostGenerationPronunciationSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips chapters with no issues and returns correct stats', async () => {
    vi.mocked(pronunciationCatalog).mockResolvedValue({
      chapters: [
        { chapterIndex: 1, fileName: '1__text.txt', failed: false, modified: false },
        { chapterIndex: 2, fileName: '2__text.txt', failed: false, modified: false },
      ],
      failedJobs: [],
    } as any);

    vi.mocked(readPronunciationChapter).mockResolvedValue({
      text: 'hello world',
      original: 'hello world',
      jobId: 'job1',
      profileId: 'profile1',
      title: 'Chap 1',
      chapterIndex: 1,
      failed: false,
      failureError: undefined,
      hash: 'testhash',
    });

    vi.mocked(scanPronunciationIssues).mockReturnValue([]); // No issues

    const stats = await runPostGenerationPronunciationSweep('book1', 'user1', 'job1');

    expect(stats.swept).toBe(0);    // no chapters had pronunciation issues
    expect(stats.skipped).toBe(2);   // both chapters were clean → skipped
    expect(stats.autoApproved).toBe(0);
    expect(stats.pendingReview).toBe(0);
    
    expect(proposePronunciationRepair).not.toHaveBeenCalled();
    expect(approveBatchRefineChange).not.toHaveBeenCalled();
  });

  it('auto-approves proposals with zero unresolved findings', async () => {
    vi.mocked(pronunciationCatalog).mockResolvedValue({
      chapters: [
        { chapterIndex: 1, fileName: '1__text.txt', failed: false, modified: false },
      ],
      failedJobs: [],
    } as any);

    vi.mocked(readPronunciationChapter).mockResolvedValue({
      text: 'hello <prosody>world</prosody>',
      original: 'hello world',
      jobId: 'job1',
      profileId: 'profile1',
      title: 'Chap 1',
      chapterIndex: 1,
      failed: false,
      failureError: undefined,
      hash: 'testhash',
    });

    vi.mocked(scanPronunciationIssues).mockReturnValue([{} as any]); // Has issues

    vi.mocked(proposePronunciationRepair).mockResolvedValue({
      runId: 'run1',
      proposalAction: 'created',
      unresolvedCount: 0,
      dictionaryRepairs: 0,
      aiRepairs: 0,
    } as any);

    const stats = await runPostGenerationPronunciationSweep('book1', 'user1', 'job1');

    expect(stats.swept).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.autoApproved).toBe(1);
    expect(stats.pendingReview).toBe(0);
    
    expect(approveBatchRefineChange).toHaveBeenCalledWith({
      changeId: 'test-change-id',
      userId: 'user1',
      skipJobIdleCheck: true,
    });
    expect(runTaskNow).toHaveBeenCalledWith('process-batch-refine-recordings');
  });
});
