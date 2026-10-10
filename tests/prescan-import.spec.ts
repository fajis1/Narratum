import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

async function buildFixture() {
  return build({
    stdin: { contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ScanForeignWordsModal} from './src/components/doclist/ScanForeignWordsModal';
      function App() { const [open,setOpen]=useState(true); return <><button onClick={()=>setOpen(true)}>Open pre-scan</button>
        <ScanForeignWordsModal isOpen={open} onClose={()=>setOpen(false)} documentId="fixture-pdf" documentName="Import fixture"/></>; }
      createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, write: false, outfile: '/tmp/prescan-import-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'preview-settings-fixture', setup(builder) {
      builder.onLoad({ filter: /useTtsPreviewSettings\.ts$/ }, () => ({ contents: 'export const useTtsPreviewSettings=()=>({voice:"af_heart",headers:{}});', loader: 'ts' }));
    } }],
  });
}

test('JSON import updates the visible manual-review count, shows saved rows and survives reopening', async ({ page }) => {
  const bundle = await buildFixture();
  let job = { id: 'job', status: 'completed', stage: 'persisting', total: 2, completed: 2, resolved: 0,
    manualReviewTerms: ['λόγος', 'θεός'], manualReviewCount: 2, words: [
      { word: 'λόγος', count: 2, pronunciations: [], definitionNeedsReview: true },
      { word: 'θεός', count: 1, pronunciations: [], definitionNeedsReview: true },
    ] as Record<string, unknown>[] };
  let imports = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (url.pathname === '/api/documents/scan-foreign-words/status') return route.fulfill({ json: job });
    if (url.pathname === '/api/documents/scan-foreign-words/import') {
      imports++;
      expect(route.request().postDataJSON()).toMatchObject({ documentId: 'fixture-pdf', jobId: 'job', continueOnError: true });
      job = { ...job, manualReviewTerms: ['θεός'], manualReviewCount: 1, words: [
        { word: 'λόγος', count: 2, pronunciations: [{ phonetic: '/loʊɡos/', isInGlobalLibrary: false }],
          libraryPronunciation: '/loʊɡos/', pronunciationSource: 'imported', definition: 'divine word', definitionNeedsReview: false },
        { ...job.words[1], importWarning: 'Invalid Kokoro pronunciation for θεός.' },
      ] };
      return route.fulfill({ json: { imported: 1, skipped: [{ word: 'θεός', reason: 'Invalid Kokoro pronunciation for θεός.' }], words: job.words, job } });
    }
    if (url.pathname === '/api/documents/source-recovery') return route.fulfill({ json: { analysis: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://localhost/');
  await expect(page.getByRole('button', { name: 'Export Manual Review JSON (2)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Flagged for Review \(2\)/ }).click();
  await page.getByLabel('Import edited foreign-word scan JSON or ZIP').setInputFiles({ name: 'edited.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    format: 'openreader-foreign-word-scan', version: 2, documentId: 'fixture-pdf', words: [{ word: 'λόγος', proposedPronunciation: '/loʊɡos/', proposedDefinition: 'divine word' }],
  })) });
  await expect(page.getByRole('button', { name: 'Export Manual Review JSON (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'λόγος' })).toContainText('divine word');
  await expect(page.getByRole('row').filter({ hasText: 'θεός' })).toContainText('Skipped');
  expect(imports).toBe(1);
  await page.getByRole('button', { name: 'Close PDF analysis', exact: true }).click();
  await page.getByRole('button', { name: 'Open pre-scan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export Manual Review JSON (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'λόγος' })).toContainText('divine word');
  expect(errors).toEqual([]);
});

test('pre-scan sends the reviewed-default preference and displays persisted benefit counters', async ({ page }) => {
  const bundle = await buildFixture();
  let job: Record<string, unknown> | null = null;
  const preferences: boolean[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (url.pathname === '/api/documents/scan-foreign-words/status') return job
      ? route.fulfill({ json: job }) : route.fulfill({ status: 404, json: { error: 'No scan yet' } });
    if (url.pathname === '/api/documents/scan-foreign-words') {
      const body = route.request().postDataJSON();
      preferences.push(body.useReviewedDefaults);
      job = { id: `job-${preferences.length}`, status: 'completed', stage: 'persisting', total: 1, completed: 1, resolved: 1,
        librarySkipped: body.useReviewedDefaults ? 4 : 0, reviewedDefaultMatches: body.useReviewedDefaults ? 4 : 0,
        formattingNormalizedTerms: 1, manualReviewTerms: [], words: [{ word: 'ἐναντίος', count: 1, pronunciations: [{ phonetic: '/ɛnɑntioʊs/' }] }] };
      return route.fulfill({ status: 202, json: { scanJobId: job.id, scanStatus: 'queued', words: [] } });
    }
    if (url.pathname === '/api/documents/source-recovery') return route.fulfill({ json: { analysis: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://localhost/');
  const defaults = page.getByLabel('Use reviewed pronunciation defaults');
  await expect(defaults).toBeChecked();
  await defaults.uncheck();
  await page.getByRole('button', { name: 'Start Scan', exact: true }).click();
  await expect(page.getByText('Gemini terms with formatting normalized: 1', { exact: true })).toBeVisible();
  await expect(page.getByText(/Reviewed defaults used:/)).toHaveCount(0);
  await defaults.check();
  await page.getByRole('button', { name: 'Scan Again', exact: true }).click();
  await expect(page.getByText('Reviewed defaults used: 4', { exact: true })).toBeVisible();
  await expect(page.getByText('Gemini terms with formatting normalized: 1', { exact: true })).toBeVisible();
  expect(preferences).toEqual([false, true]);
  await page.getByRole('button', { name: 'Close PDF analysis', exact: true }).click();
  await page.getByRole('button', { name: 'Open pre-scan', exact: true }).click();
  await expect(page.getByText('Reviewed defaults used: 4', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('pre-scan distinguishes contextual language, uncertain abbreviations and source repair', async ({ page }) => {
  const bundle = await buildFixture();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const job = { id: 'languages', status: 'completed', stage: 'persisting', total: 2, completed: 2, manualReviewTerms: [], words: [
    { word: 'очи', count: 1, detectedLanguage: 'church_slavonic', languageConfidence: 0.9, definition: 'eyes',
      pronunciations: [{ phonetic: '/oʊtʃi/', isInGlobalLibrary: false }] },
    { word: 'μτλ', count: 1, detectedLanguage: 'unknown', ambiguityReason: 'abbreviation', languageConfidence: 0.2,
      sourceOutcome: 'insufficient_context', definitionOmitted: true, pronunciations: [] },
    { word: 'оchи', count: 1, sourceStatus: 'needs_source_repair', pronunciations: [] },
  ] };
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (url.pathname === '/api/documents/scan-foreign-words/status') return route.fulfill({ json: job });
    if (url.pathname === '/api/documents/source-recovery') return route.fulfill({ json: { analysis: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto('http://localhost/');
  const accepted = page.getByRole('row').filter({ hasText: 'очи' });
  await expect(accepted).toContainText('Church Slavonic');
  await expect(accepted).toContainText('eyes');
  const abbreviation = page.getByRole('row').filter({ hasText: 'μτλ' });
  await expect(abbreviation).toContainText('Language uncertain');
  await expect(abbreviation).toContainText('Context does not establish how to read this abbreviation.');
  await expect(abbreviation).toContainText('Definition intentionally omitted');
  await expect(page.getByRole('row').filter({ hasText: 'оchи' })).toContainText('Verify and repair the extracted text against the PDF.');
  expect(errors).toEqual([]);
});
