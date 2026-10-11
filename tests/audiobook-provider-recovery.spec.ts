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
  await expect(page.getByRole('button', { name: 'Retry Gemini now', exact: true })).toHaveCount(0);
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

test('queued Gemini repair shows a live countdown, waits honestly when due, and clears it on resume', async ({ page }) => {
  const bundle = await fixtureBundle('queue');
  const start = new Date('2026-10-11T12:00:00Z');
  await page.clock.install({ time: start });
  let status = 'queued';
  const settingsJson = {
    nextAttemptAt: start.getTime() + 5000,
    providerRetry: { count: 1, exhausted: false, failure: { provider: 'gemini', model: 'gemini-3.8-flash', httpStatus: 429, stage: 'targeted_pronunciation_repair' } },
    // The durable queue schedule must win over an old in-flight cooldown.
    geminiCooldown: { reason: 'rate_limit', startedAt: start.getTime() - 10000, retryAt: start.getTime() + 60000, serverDirected: true },
  };
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/api/audiobooks/queue') return json({ jobs: [{
      id: 'waiting', documentId: 'book', documentTitle: 'paulmoseshistory0000hafe', status, progress: 50,
      createdAt: start.getTime() - 60000, startedAt: start.getTime() - 60000, updatedAt: start.getTime(), globalQueuePosition: 1,
      error: status === 'queued' ? 'gemini / gemini-3.8-flash temporarily unavailable (HTTP 429) during targeted_pronunciation_repair. Completed chapters are preserved. Waiting for gemini; automatic retry scheduled.' : null,
      settingsJson: status === 'queued' ? settingsJson : { ...settingsJson, geminiCooldown: null },
    }], activeGlobalJob: { startedAt: start.getTime() - 60000, updatedAt: start.getTime(), progress: 50 } });
    return json({});
  });
  await page.goto('http://localhost/');
  await expect(page.getByText('Waiting for Gemini', { exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText('Automatic retry at 2026-10-11 12:00:05 UTC — 5s remaining.');
  await expect(page.getByText('50% complete · progress preserved', { exact: true })).toBeVisible();
  await expect(page.getByText(/remaining before processing/)).toHaveCount(0);
  await page.clock.runFor(2000);
  await expect(page.getByRole('timer')).toContainText('3s remaining.');
  await page.clock.runFor(3000);
  await expect(page.getByRole('timer')).toHaveText('Retry time has arrived. Waiting for the queue to resume processing.');
  await expect(page.getByText('Waiting for Gemini', { exact: true })).toBeVisible();
  status = 'running';
  await page.clock.runFor(5000);
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveCount(0);
});

test('Retry Gemini now handles conflicts, disables duplicate clicks, and supports another rate-limit wait', async ({ page }) => {
  const bundle = await fixtureBundle('queue');
  const start = new Date('2026-10-11T12:00:00Z');
  await page.clock.install({ time: start });
  const mutations: unknown[] = [];
  let status = 'queued';
  let nextAttemptAt = start.getTime() + 300000;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/api/audiobooks/queue') {
      if (route.request().method() === 'PUT') {
        mutations.push(route.request().postDataJSON());
        if (mutations.length === 1) return json({ error: 'This job is already active.' }, 409);
        if (mutations.length === 2) await pending;
        else status = 'running';
        return json({ success: true });
      }
      return json({ jobs: [{ id: 'waiting', documentId: 'book', documentTitle: 'paulmoseshistory0000hafe', status, progress: 50, createdAt: 1,
        settingsJson: { nextAttemptAt, providerRetry: { count: 1, exhausted: false, failure: { provider: 'gemini', model: 'gemini-3.8-flash' } } },
      }] });
    }
    return json({});
  });
  await page.goto('http://localhost/');
  await page.getByRole('button', { name: 'Retry Gemini now', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('This job is already active.');
  await expect(page.getByRole('timer')).toContainText('5m 0s remaining.');
  await page.getByRole('button', { name: 'Retry Gemini now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Requesting retry…', exact: true })).toBeDisabled();
  expect(mutations).toEqual([{ id: 'waiting' }, { id: 'waiting' }]);
  release();
  await expect(page.getByRole('timer')).toHaveText('Retry requested. Waiting for the queue to resume processing.');
  await expect(page.getByRole('button', { name: 'Retry Gemini now', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // A subsequent 429 publishes a fresh timestamp on the same job.
  nextAttemptAt = start.getTime() + 600000;
  await page.clock.runFor(5000);
  await expect(page.getByRole('button', { name: 'Retry Gemini now', exact: true })).toBeEnabled();
  await expect(page.getByRole('timer')).toContainText('9m 55s remaining.');
  await expect(page.getByText('50% complete · progress preserved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry Gemini now', exact: true }).click();
  await expect(page.getByText('Running', { exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry Gemini now', exact: true })).toHaveCount(0);
  expect(mutations).toEqual([{ id: 'waiting' }, { id: 'waiting' }, { id: 'waiting' }]);
});
