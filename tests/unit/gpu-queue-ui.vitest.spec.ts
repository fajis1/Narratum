import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewJobStatus } from '@/components/audiobooks/review/ReviewJobStatus';
import { describe, expect, test } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('GPU queue status UI wiring', () => {
  test('projects the temporary phase from the existing job settings field', () => {
    const queueRoute = source('src/app/api/audiobooks/queue/route.ts');
    expect(queueRoute).toContain('readAudiobookRuntimeStatus(row.job.settingsJson, row.job.status)');
    expect(queueRoute).toContain('phase: runtimeStatus.phase');
    expect(queueRoute).toContain('gpuQueueState: runtimeStatus.gpuQueueState');
  });

  test('shows an automatic-resume message in every audiobook progress surface', () => {
    const exportModal = source('src/components/AudiobookExportModal.tsx');
    const listener = source('src/app/(app)/listen/[bookId]/page.tsx');
    const inlineJobs = source('src/components/doclist/views/JobsInlineView.tsx');

    expect(exportModal).toContain('Waiting for the shared GPU. Kokoro has priority');
    expect(listener).toContain('waiting={isWaitingForGpu}');
    const waiting = renderToStaticMarkup(createElement(ReviewJobStatus, { label: 'Generating audiobook', progress: 0, waiting: true, reviewChanges: false, onReview: () => {}, changelogUrl: '', onCancel: () => {} }));
    expect(waiting).toContain('Generating audiobook · Waiting for GPU');
    expect(waiting).toContain('Kokoro will start automatically when the shared GPU is ready.');
    expect(inlineJobs).toContain('Your audiobook progress is preserved.');
    expect(inlineJobs).toContain('Cancel Generation');
  });

  test('documents opt-in server-only arbiter configuration', () => {
    const envExample = source('.env.example');
    expect(envExample).toContain('# GPU_QUEUE_STATUS_ENABLED=false');
    expect(envExample).toContain('# GPU_ARBITER_STATUS_URL=http://192.168.90.246:11435/gpu/status');
  });
});
