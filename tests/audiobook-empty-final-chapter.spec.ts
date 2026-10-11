import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

async function bundle() {
  const result = await build({ stdin: {
    contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {OmitEmptyFinalChapterButton} from './src/components/audiobooks/OmitEmptyFinalChapterButton';
      function Fixture() { const [omitted, setOmitted] = useState(false); return omitted ? <p>Ready for Audiobookshelf</p> :
        <OmitEmptyFinalChapterButton bookId="book" chapterIndex={73} snapshotHash={'a'.repeat(64)} onOmitted={()=>setOmitted(true)}/>; }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    loader: 'tsx', resolveDir: process.cwd(),
  }, bundle: true, write: false, outfile: '/tmp/empty-final-chapter-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' } });
  return result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
}

test('omitting chapter 74 requires confirmation, disables duplicate clicks, and reports stale-source errors', async ({ page }) => {
  const source = await bundle();
  const requests: unknown[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: source });
    if (url.pathname === '/api/audiobook/omit-empty-final-chapter') {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'The chapter changed. Refresh and review it.' }) });
      await pending;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto('http://localhost/');
  await page.getByRole('button', { name: 'Omit empty final chapter', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Existing recordings will be preserved.');
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Omit empty final chapter', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm omission', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('The chapter changed. Refresh and review it.');
  await expect(page.getByText('Ready for Audiobookshelf')).toHaveCount(0);
  await page.getByRole('button', { name: 'Omit empty final chapter', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm omission', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Omitting chapter…', exact: true })).toBeDisabled();
  release();
  await expect(page.getByText('Ready for Audiobookshelf')).toBeVisible();
  expect(requests).toEqual(Array(2).fill({ bookId: 'book', chapterIndex: 73, snapshotHash: 'a'.repeat(64), confirmOmit: true }));
});
