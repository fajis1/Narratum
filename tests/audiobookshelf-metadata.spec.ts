import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

for (const author of ['Zoë García', 'Unknown Author', '']) test(`metadata author suggestion: ${author || 'unidentified'}`, async ({ page }) => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {Toaster} from 'react-hot-toast'; import {AudiobookshelfModal} from './src/components/audiobooks/AudiobookshelfModal';
      createRoot(document.getElementById('root')).render(<><Toaster/><AudiobookshelfModal open={true} onClose={()=>{}} bookId="fixture-book" initialTitle="Book.pdf" initialAuthor="Existing Local Author" chapters={[{index:0,title:'One',hasAudio:true}]}/></>);`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, write: false, outfile: '/tmp/abs-metadata-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'mock-next-navigation', setup(plugin) {
      plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function useRouter(){ return {refresh(){},push(){}}; }' }));
    } }],
  });
  const matchAuthors: string[] = [];
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div id="root"></div><script src="/bundle.js"></script>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles[0].text });
    if (url.pathname.endsWith('/infer-title')) return json({ success: true, metadata: { title: 'Suggested Book', author } });
    if (url.pathname.endsWith('/match')) {
      matchAuthors.push(route.request().postDataJSON().author);
      return json({ matchFound: false, candidate: null });
    }
    if (url.pathname.endsWith('/audiobookshelf')) return json({ configured: true, url: 'http://fixture-library', autoDetectMetadata: true, libraries: [{ id: 'library', name: 'Books', mediaType: 'book', folders: [{ id: 'folder', fullPath: '/books' }] }] });
    return json({ chapters: [] });
  });
  await page.goto('http://localhost/');
  await expect(page.getByLabel('Author', { exact: true })).toHaveValue(author === 'Zoë García' ? author : 'Existing Local Author');
  await expect(page.getByText('No web search is performed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: author === 'Zoë García' ? 'Author suggested from document evidence' : 'Author not identified in the available document evidence' })).toBeVisible();
  await expect.poll(() => matchAuthors.length).toBeGreaterThan(0);
  expect(matchAuthors).not.toContain('Unknown Author');
});
