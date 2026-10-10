import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

test('JSON import updates the visible manual-review count, shows saved rows and survives reopening', async ({ page }) => {
  const bundle = await build({
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
