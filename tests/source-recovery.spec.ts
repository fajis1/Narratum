import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import type { SourceRecoveryAnalysis, SourceRecoveryOccurrence } from '../src/types/source-recovery';

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`OCR source recovery supports visible analysis and bulk review on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const bundle = await build({
      stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {SourceRecoveryPanel} from './src/components/doclist/SourceRecoveryPanel';
        createRoot(document.getElementById('root')).render(<SourceRecoveryPanel documentId="fixture-pdf"/>);`,
        loader: 'tsx', resolveDir: process.cwd() },
      bundle: true, write: false, outfile: '/tmp/source-recovery-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
      alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    });
    const base = (id: string) => ({ id, groupId: 'group', surface: 'xatagyéw', pdfPage: 1,
      pageSourceStart: Number(id.slice(-1)), surfaceOccurrenceIndex: Number(id.slice(-1)), surfaceOccurrenceCount: 2,
      before: 'The word ', after: ' means abolish.', context: 'The word xatagyéw means abolish.', reasons: ['Possible OCR'], status: 'unresolved' });
    const analysis: SourceRecoveryAnalysis = {
      schemaVersion: 1, documentId: 'fixture-pdf', revision: 1, extractionVersion: 1, scannedAt: 1,
      occurrences: [base('id-1'), base('id-2')] as SourceRecoveryOccurrence[], diagnostics: [],
    };
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://localhost/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      if (url.pathname === '/api/documents/source-recovery' && route.request().method() === 'GET') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis }) });
      }
      if (url.pathname === '/api/documents/source-recovery' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body.action === 'propose') {
          analysis.revision++;
          for (const item of analysis.occurrences) {
            item.status = 'proposed'; item.analyzedAt = 2;
            item.proposal = { correctedSurface: 'καταργέω', lemma: 'καταργέω', language: 'koine_greek',
              explanation: 'Fixture proposal only', visualEvidence: 'text_block_crop_provided', dictionary: null,
              pronunciation: null, pronunciationReference: null };
          }
          analysis.diagnostics.push({ outcome: 'proposed', groupId: 'group', attempted: true, at: 2, message: 'Two fixture proposals.' });
          analysis.recoveryRun = { status: 'completed', batchesCompleted: 1, updatedAt: 2 };
        } else if (body.action === 'approve_many') {
          analysis.revision++;
          for (const item of analysis.occurrences) if (body.occurrenceIds.includes(item.id)) item.status = 'approved';
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis }) });
      }
      return route.fulfill({ status: 404, body: 'Not found' });
    });
    await page.goto('http://localhost/');
    await expect(page.getByRole('region', { name: 'OCR source recovery' })).toBeVisible();
    await expect(page.getByText(/not analyzed 2/)).toBeVisible();
    await page.getByRole('button', { name: 'Analyze OCR Problems' }).click();
    await expect(page.getByText('Two fixture proposals.')).toBeVisible();
    await page.getByLabel('I verified occurrence on page 1').first().check();
    await page.getByRole('button', { name: 'Approve 1 selected' }).click();
    await expect(page.getByText(/approved 1/)).toBeVisible();
    expect(analysis.occurrences.filter((item) => item.status === 'approved')).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });
}
