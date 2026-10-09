import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

async function fixtureBundle(component: 'queue' | 'history') {
  const contents = component === 'queue'
    ? "import {JobsInlineView} from './src/components/doclist/views/JobsInlineView'; createRoot(document.getElementById('root')).render(<JobsInlineView/>);"
    : "import {ChapterErrorLogModal} from './src/components/audiobooks/ChapterErrorLogModal'; createRoot(document.getElementById('root')).render(<ChapterErrorLogModal open={true} onClose={()=>{}} bookId='book'/>);";
  const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; ${contents}`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, outfile: '/tmp/provider-recovery-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic', alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
  return bundle.outputFiles.find(f => f.path.endsWith('.js'))!.text;
}

test('Kokoro cooldown is waiting; a legacy partial completion offers Retry Missing Chapters and reports conflicts', async ({ page }) => {
  const bundle = await fixtureBundle('queue');
  const mutations: unknown[] = [];
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/api/audiobooks/queue') {
      if (route.request().method() === 'PUT') { mutations.push(route.request().postDataJSON()); return json({ error: 'Another job for this audiobook is active.' }, 409); }
      return json({ jobs: [
        { id: 'waiting', documentId: 'book', documentTitle: 'Waiting book', status: 'queued', progress: 50, createdAt: 1, error: 'custom-openai / kokoro temporarily unavailable (HTTP 503). Completed chapters are preserved. Automatic retry scheduled.', settingsJson: { providerRetry: { failure: { provider: 'custom-openai', model: 'kokoro' }, count: 1 }, nextAttemptAt: Date.now() + 300000 } },
        { id: 'partial', documentId: 'partial', documentTitle: 'Partial book', status: 'completed', createdAt: 1, error: '9 chapters require manual review before full-book download.', settingsJson: {} },
      ] });
    }
    return json({});
  });
  await page.goto('http://localhost/');
  await expect(page.getByText('Waiting for Kokoro', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All (2)', exact: true }).click();
  await expect(page.getByText('Incomplete', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Listen / Download', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry Missing Chapters', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Another job for this audiobook is active.');
  expect(mutations).toEqual([{ id: 'partial' }]);
});

test('failure log distinguishes automatic retry, recovered history, and genuine content review', async ({ page }) => {
  const bundle = await fixtureBundle('history');
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ bookId: 'book', jobStatus: 'queued', failures: [
      { chapterIndex: 0, errors: ['HTTP 503'], state: 'retry_scheduled', failureCategory: 'provider_transient', retryScheduled: true },
      { chapterIndex: 1, errors: ['Previous HTTP 429'], state: 'recovered_history', failureCategory: 'provider_transient', retryScheduled: false },
      { chapterIndex: 2, errors: ['Invalid IPA'], state: 'manual_review', failureCategory: 'content_validation' },
    ], reviewFlags: [] }) });
  });
  await page.goto('http://localhost/');
  await expect(page.getByText('Temporary provider failure — automatic retry scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered — retained diagnostic history', { exact: true })).toBeVisible();
  await expect(page.getByText('Content requires review', { exact: true })).toBeVisible();
});
