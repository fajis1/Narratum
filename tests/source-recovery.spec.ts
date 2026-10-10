import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

let workspaceCss = '';
test.beforeAll(() => {
  const cssPath = `/tmp/ocr-workspace-${process.pid}.css`;
  execFileSync(process.execPath, ['node_modules/tailwindcss/lib/cli.js', '-i', 'src/app/globals.css', '-o', cssPath], { cwd: process.cwd(), stdio: 'pipe' });
  workspaceCss = readFileSync(cssPath, 'utf8');
});
import type { SourceRecoveryAnalysis, SourceRecoveryOccurrence } from '../src/types/source-recovery';

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`OCR source recovery supports visible analysis and bulk review on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const bundle = await build({
      stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {SourceRecoveryPanel} from './src/components/doclist/SourceRecoveryPanel';
        import {ScanRecoveryWorkspace} from './src/components/doclist/ScanRecoveryWorkspace';
        const root = createRoot(document.getElementById('root'));
        window.refreshRecoverySummary = (applied) => root.render(<ScanRecoveryWorkspace recovery={<SourceRecoveryPanel documentId="fixture-pdf" refreshToken={1} applicationSummary={{applied,unmatched:0}}/>}><p>Pre-scan fixture controls</p></ScanRecoveryWorkspace>);
        window.refreshRecoverySummary(0);`,
        loader: 'tsx', resolveDir: process.cwd() },
      bundle: true, write: false, outfile: '/tmp/source-recovery-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
      alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    });
    const base = (id: string) => ({ id, groupId: 'group', surface: 'xatagyéw', pdfPage: 1,
      pageSourceStart: Number(id.slice(-1)), surfaceOccurrenceIndex: Number(id.slice(-1)), surfaceOccurrenceCount: 2,
      before: 'The word ', after: ' means abolish.', context: 'The word xatagyéw means abolish.', reasons: ['Possible OCR'], status: 'unresolved' });
    const analysis: SourceRecoveryAnalysis = {
      schemaVersion: 1, documentId: 'fixture-pdf', revision: 1, extractionVersion: 1, scannedAt: 1,
      occurrences: [base('id-1'), base('id-2'), { ...base('id-3'), groupId: 'other-group' }] as SourceRecoveryOccurrence[], diagnostics: [],
    };
    let analysisRequests = 0;
    let approvalRequests = 0;
    let finishAnalysis!: () => void;
    const analysisReady = new Promise<void>(resolve => { finishAnalysis = resolve; });
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://localhost/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="root" style="position:fixed;inset:16px;"></div><script src="/bundle.js"></script>' });
      if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: workspaceCss });
      if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      if (url.pathname === '/api/documents/source-recovery' && route.request().method() === 'GET') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis, configuration: { profileId: 'saved', profileName: 'Saved Scholar profile', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.7-flash'], primaryKeyConfigured: true, backupKeyConfigured: true, automaticBackupFailover: true } }) });
      }
      if (url.pathname === '/api/documents/source-recovery' && route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (body.action === 'propose') {
          analysisRequests++;
          expect(body.ocrModel).toBe('gemini-3.7-flash');
          expect(body.useBackupKey).toBe(true);
          expect(body).not.toHaveProperty('geminiApiKey');
          expect(body).not.toHaveProperty('backupGeminiApiKey');
          await analysisReady;
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
          for (const item of analysis.occurrences) if (body.occurrenceIds.includes(item.id)) {
            item.status = 'approved'; item.approvalMethod = 'pdf_review';
          }
        } else if (body.action === 'approve_all_suggestions') {
          approvalRequests++;
          expect(body.acceptGeminiSuggestions).toBe(true);
          expect(body).not.toHaveProperty('sourceVerifiedOccurrenceIds');
          expect(body.sourceVerified).toBe(false);
          expect(body.revision).toBe(analysis.revision);
          analysis.revision++;
          for (const item of analysis.occurrences) if (item.status === 'proposed' && !item.anchorInvalidated) {
            item.status = 'approved'; item.approvalMethod = 'gemini_suggestions';
          }
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis, configuration: { profileId: 'saved', profileName: 'Saved Scholar profile', model: 'gemini-3.8-flash', fallbackModels: ['gemini-3.7-flash'], primaryKeyConfigured: true, backupKeyConfigured: true, automaticBackupFailover: true } }) });
      }
      return route.fulfill({ status: 404, body: 'Not found' });
    });
    await page.goto('http://localhost/');
    await expect(page.getByRole('tabpanel', { name: 'Pre-Scan' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'OCR source recovery' })).toBeHidden();
    await page.getByRole('tab', { name: 'OCR Recovery' }).click();
    await expect(page.getByRole('region', { name: 'OCR source recovery' })).toBeVisible();
    await expect(page.getByText('Smart Audio profile: Saved Scholar profile')).toBeVisible();
    await page.getByLabel('OCR Gemini model', { exact: true }).selectOption('gemini-3.7-flash');
    await page.getByLabel('Use backup API key for next OCR analysis').check();
    await expect(page.getByText(/not analyzed 3/)).toBeVisible();
    await page.getByRole('button', { name: 'Analyze OCR Problems' }).click();
    await expect.poll(() => analysisRequests).toBe(1);
    await page.getByRole('tab', { name: 'Pre-Scan', exact: true }).click();
    await expect(page.getByText('Pre-scan fixture controls')).toBeVisible();
    await page.getByRole('tab', { name: 'OCR Recovery', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Analyze OCR Problems' })).toBeDisabled();
    expect(analysisRequests).toBe(1);
    finishAnalysis();
    await expect(page.getByText('Two fixture proposals.')).toBeVisible();
    await expect(page.getByLabel('Use backup API key for next OCR analysis')).not.toBeChecked();
    await page.getByLabel('I verified occurrence on page 1').first().check();
    await page.getByRole('button', { name: 'Approve 1 selected' }).click();
    await expect(page.getByText(/approved 1/)).toBeVisible();
    expect(analysis.occurrences.filter((item) => item.status === 'approved')).toHaveLength(1);
    await expect(page.getByText(/1 approved reading\(s\) not represented/)).toBeVisible();
    await page.evaluate(() => (window as unknown as { refreshRecoverySummary: (count: number) => void }).refreshRecoverySummary(1));
    await expect(page.getByText(/Last pre-scan: 1 approved reading\(s\) applied/)).toBeVisible();
    await page.getByLabel('Occurrence', { exact: true }).selectOption('id-2');
    const accept = page.getByRole('button', { name: 'Accept this occurrence' });
    await accept.scrollIntoViewIfNeeded();
    await expect(accept).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Reject correction' })).toBeInViewport();
    const workspace = await page.getByTestId('scan-recovery-workspace').boundingBox();
    expect(workspace!.height).toBeLessThan(viewport.height - 16);
    const recoveryPanel = page.getByRole('tabpanel', { name: 'OCR Recovery' });
    expect(await recoveryPanel.evaluate(el => getComputedStyle(el).overflowY)).toBe('auto');
    expect(await page.getByRole('region', { name: 'OCR source recovery' }).evaluate(el => getComputedStyle(el).overflowY)).toBe('visible');
    await page.getByRole('tab', { name: 'Pre-Scan', exact: true }).click();
    await page.getByRole('tab', { name: 'OCR Recovery', exact: true }).click();
    await expect(page.getByLabel('Occurrence', { exact: true })).toHaveValue('id-2');
    expect(analysisRequests).toBe(1);
    await page.getByRole('button', { name: 'Approve all Gemini suggestions', exact: true }).click();
    await expect(page.getByText(/without claiming manual PDF verification/)).toBeVisible();
    expect(approvalRequests).toBe(0);
    await page.getByRole('button', { name: 'Cancel bulk approval' }).click();
    await expect(page.getByRole('button', { name: 'Confirm approval of 2 suggestions' })).toHaveCount(0);
    expect(approvalRequests).toBe(0);
    await page.getByRole('button', { name: 'Approve all Gemini suggestions', exact: true }).click();
    const confirmAll = page.getByRole('button', { name: 'Confirm approval of 2 suggestions' });
    await confirmAll.scrollIntoViewIfNeeded();
    await expect(confirmAll).toBeInViewport();
    await confirmAll.click();
    await expect(page.getByText(/approved 3/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve all Gemini suggestions', exact: true })).toHaveCount(0);
    expect(approvalRequests).toBe(1);
    expect(analysisRequests).toBe(1);
    expect(analysis.occurrences.map(item => item.approvalMethod)).toEqual(['pdf_review', 'gemini_suggestions', 'gemini_suggestions']);
    await expect(page.getByText('Approved by accepting Gemini suggestions; manual PDF verification was not recorded.')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`OCR diagnostics distinguish renderer, HTTP and cancellation on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {SourceRecoveryPanel} from './src/components/doclist/SourceRecoveryPanel';
      createRoot(document.getElementById('root')).render(<SourceRecoveryPanel documentId="fixture-pdf"/>);`, loader: 'tsx', resolveDir: process.cwd() },
      bundle: true, write: false, outfile: '/tmp/source-recovery-errors-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
      alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
    const analysis: SourceRecoveryAnalysis = { schemaVersion: 1, documentId: 'fixture-pdf', revision: 1, extractionVersion: 13, scannedAt: 1,
      occurrences: [{ id: 'one', groupId: 'group', surface: 'xatagyéw', pdfPage: 1, pageSourceStart: 0,
        before: '', after: '', context: 'xatagyéw', reasons: ['OCR'], status: 'unresolved' }],
      diagnostics: [{ at: 1, groupId: 'group', attempted: false, outcome: 'renderer_error', stage: 'renderer_startup', attempts: [],
        message: 'PDF renderer could not start. Gemini was not contacted.' }] };
    let requests = 0;
    await page.route('http://localhost/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: workspaceCss });
      if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
      if (route.request().method() === 'POST') {
        requests++;
        if (requests === 1) {
          analysis.revision++;
          analysis.diagnostics.push({ at: 2, groupId: 'group', attempted: true, outcome: 'provider_error', stage: 'gemini_request',
            httpStatus: 503, usedBackup: true, retryable: true, message: 'Gemini returned HTTP 503 using the backup key.',
            attempts: [{ at: 2, attempt: 1, stage: 'gemini_request', model: 'gemini-3.8-flash', keyRole: 'primary', httpStatus: 429, retryable: true, fallbackAttempted: true, outcome: 'failed' },
              { at: 3, attempt: 2, stage: 'gemini_request', model: 'gemini-3.8-flash', keyRole: 'backup', httpStatus: 503, retryable: true, fallbackAttempted: false, outcome: 'failed' }] });
        } else {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis }) });
    });
    await page.goto('http://localhost/');
    await expect(page.getByText('PDF renderer could not start. Gemini was not contacted.', { exact: false })).toBeVisible();
    await expect(page.getByText('0 Gemini request(s)')).toBeVisible();
    await page.getByRole('button', { name: 'Analyze OCR Problems' }).click();
    await expect(page.getByText(/Primary \/ gemini-3.8-flash — HTTP 429/)).toBeVisible();
    await expect(page.getByText(/Backup \/ gemini-3.8-flash — HTTP 503/)).toBeVisible();
    await expect(page.getByText('2 Gemini request(s)')).toBeVisible();
    await page.getByRole('button', { name: 'Analyze OCR Problems' }).click();
    await expect.poll(() => requests).toBe(2);
    await page.getByRole('button', { name: 'Cancel OCR analysis' }).click();
    await expect(page.getByRole('alert')).toContainText('OCR analysis cancelled');
    await expect(page.getByRole('button', { name: 'Analyze OCR Problems' })).toBeEnabled();
    expect(requests).toBe(2);
    expect(await page.content()).not.toContain('x-goog-api-key');
  });
}
