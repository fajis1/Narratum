import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('Audiobook queue cleanup and filtering', () => {
  test('DELETE route supports bulk clearing of completed, failed, and finished jobs', () => {
    const queueRoute = source('src/app/api/audiobooks/queue/route.ts');
    expect(queueRoute).toContain("const clear = url.searchParams.get('clear');");
    expect(queueRoute).toContain("clear === 'completed'");
    expect(queueRoute).toContain("clear === 'error' || clear === 'failed'");
    expect(queueRoute).toContain("clear === 'finished' || clear === 'all_inactive'");
    expect(queueRoute).toContain("const idsParam = url.searchParams.get('ids');");
  });

  test('PUT route supports bulk requeue of all failed jobs', () => {
    const queueRoute = source('src/app/api/audiobooks/queue/route.ts');
    expect(queueRoute).toContain('requeueAllFailed === true');
    expect(queueRoute).toContain("eq(audiobookJobs.status, 'error')");
    expect(queueRoute).toContain("status: 'queued'");
  });

  test('JobsInlineView provides filter tabs, bulk cleanup actions, and intelligent sorting', () => {
    const inlineJobs = source('src/components/doclist/views/JobsInlineView.tsx');
    // Tab filters
    expect(inlineJobs).toContain("type QueueFilter = 'active' | 'all' | 'completed' | 'failed'");
    expect(inlineJobs).toContain('Active ({activeJobs.length})');
    expect(inlineJobs).toContain('Completed ({completedJobs.length})');
    expect(inlineJobs).toContain('Failed ({failedJobs.length})');
    // Bulk actions in header
    expect(inlineJobs).toContain('Clear Completed');
    expect(inlineJobs).toContain('Dismiss All Errors');
    expect(inlineJobs).toContain('Requeue All Errors');
    expect(inlineJobs).toContain('Clear All Finished');
    // Row actions
    expect(inlineJobs).toContain('Listen / Download');
    expect(inlineJobs).toContain('Cancel Generation');
    expect(inlineJobs).toContain('Dismiss');
    expect(inlineJobs).toContain('Clear');
    // MultiVoice casting modal compatibility
    expect(inlineJobs).toContain('<MultiVoiceCharacterModal');
  });
});
