import { test, expect, Page } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import util from 'util';
import { execFile } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import JSZip from 'jszip';
import { setupTest, uploadAndDisplay } from './helpers';

const execFileAsync = util.promisify(execFile);

function isTransientRequestError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message || '';
  return (
    msg.includes('ECONNRESET') ||
    msg.includes('socket hang up') ||
    msg.includes('ERR_SOCKET_CLOSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed')
  );
}

async function requestWithRetry(
  fn: () => Promise<APIResponse>,
  { attempts = 4, backoffMs = 200 }: { attempts?: number; backoffMs?: number } = {},
): Promise<APIResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientRequestError(error) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Request failed');
}

async function getBookIdFromUrl(page: Page, expectedPrefix: 'pdf' | 'epub') {
  const url = new URL(page.url());
  const segments = url.pathname.split('/').filter(Boolean);
  expect(segments[0]).toBe(expectedPrefix);
  const bookId = segments[1];
  expect(bookId).toBeTruthy();
  return bookId;
}

async function uploadCompactRecoveryEpub(page: Page) {
  const chapters = [
    {
      id: 'chapter-1',
      title: 'First Chapter',
      text: 'The first compact chapter establishes the audiobook recovery test with predictable prose. '.repeat(80),
    },
    {
      id: 'chapter-2',
      title: 'Second Chapter',
      text: 'The second compact chapter provides another independently recoverable audio segment. '.repeat(80),
    },
    {
      id: 'chapter-3',
      title: 'Third Chapter',
      text: 'The third compact chapter completes the deliberately small test audiobook cleanly. '.repeat(80),
    },
  ];
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">openreader-playwright-recovery</dc:identifier>
    <dc:title>Compact Recovery Test</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${chapters.map((chapter) => `<item id="${chapter.id}" href="${chapter.id}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine>${chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join('')}</spine>
</package>`);
  for (const chapter of chapters) {
    zip.file(`OEBPS/${chapter.id}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head><title>${chapter.title}</title></head>
  <body><h1>${chapter.title}</h1><p>${chapter.text}</p></body>
</html>`);
  }

  const epub = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const input = page.locator('input[type=file]').first();
  await expect(input).toBeAttached({ timeout: 10_000 });
  await expect(input).toBeEnabled({ timeout: 10_000 });
  await input.setInputFiles({
    name: 'compact-recovery.epub',
    mimeType: 'application/epub+zip',
    buffer: epub,
  });
  await expect(input).toBeEnabled({ timeout: 15_000 });

  const targetLink = page.getByRole('link', { name: /compact-recovery\.epub/i }).first();
  await expect(targetLink).toBeVisible({ timeout: 15_000 });
  await targetLink.click();
  await page.waitForSelector('.epub-container', { timeout: 10_000 });
}

async function openExportModal(page: Page) {
  const exportButton = page.getByRole('button', { name: 'Open audiobook export' });
  await expect(exportButton).toBeVisible({ timeout: 15_000 });
  await exportButton.click();
  await expect(page.getByRole('heading', { name: 'Export Audiobook' })).toBeVisible({ timeout: 15_000 });
}

async function setContainerFormatToMP3(page: Page) {
  const formatTrigger = page.getByRole('button', { name: /M4B|MP3/i });
  await expect(formatTrigger).toBeVisible({ timeout: 15_000 });
  await formatTrigger.click();
  await page.getByRole('option', { name: 'MP3' }).click();
}

async function startGeneration(page: Page) {
  const startButton = page.getByRole('button', { name: 'Start Generation' });
  await expect(startButton).toBeVisible({ timeout: 15_000 });
  await startButton.click();
}

async function waitForChaptersHeading(page: Page) {
  await expect(page.getByRole('heading', { name: 'Chapters' })).toBeVisible({ timeout: 120_000 });
}

type DownloadedAudiobook = {
  filePath: string;
  suggestedFilename: string;
  cleanup: () => Promise<void>;
};

async function downloadViaTrigger(
  page: Page,
  trigger: () => Promise<void>,
  timeoutMs = 60_000,
): Promise<DownloadedAudiobook> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: timeoutMs }),
    trigger(),
  ]);
  const failure = await download.failure();
  expect(failure).toBeNull();

  const suggestedFilename = download.suggestedFilename();
  let createdTempDir: string | null = null;
  let filePath = await download.path();

  // Some environments/browsers may not expose a stable download path; fall back to saving
  // into a temp directory outside the repo (and clean up after assertions).
  if (!filePath) {
    createdTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openreader-audiobook-'));
    const name = suggestedFilename || `download_${Date.now()}.mp3`;
    filePath = path.join(createdTempDir, name);
    await download.saveAs(filePath);
  }

  expect(fs.existsSync(filePath)).toBeTruthy();
  const stats = fs.statSync(filePath);
  expect(stats.size).toBeGreaterThan(0);
  return {
    filePath,
    suggestedFilename,
    cleanup: async () => {
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // ignore
      }
      if (createdTempDir) {
        await fs.promises.rm(createdTempDir, { recursive: true, force: true });
      }
    },
  };
}

async function downloadFullAudiobook(page: Page, timeoutMs = 60_000): Promise<DownloadedAudiobook> {
  const fullDownloadButton = page.getByRole('button', { name: /Full Download/i });
  await expect(fullDownloadButton).toBeVisible({ timeout: timeoutMs });
  await expect(fullDownloadButton).toBeEnabled({ timeout: timeoutMs });

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloadViaTrigger(page, () => fullDownloadButton.click(), timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      await page.waitForTimeout(250 * attempt);
      await expect(fullDownloadButton).toBeVisible({ timeout: timeoutMs });
      await expect(fullDownloadButton).toBeEnabled({ timeout: timeoutMs });
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Full download failed');
}

async function getAudioDurationSeconds(filePath: string) {
  if (!ffmpegPath) throw new Error('ffmpeg-static binary is unavailable');
  try {
    // ffmpeg -i outputs metadata to stderr
    await execFileAsync(ffmpegPath, ['-i', filePath]);
  } catch (error: unknown) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String(error.stderr ?? '')
      : '';
    const match = stderr.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)/);
    if (match) {
      const hours = parseFloat(match[1]);
      const minutes = parseFloat(match[2]);
      const seconds = parseFloat(match[3]);
      return hours * 3600 + minutes * 60 + seconds;
    }
  }
  return 0;
}

async function expectChaptersBackendState(page: Page, bookId: string) {
  const res = await requestWithRetry(() => page.request.get(`/api/audiobook/status?bookId=${bookId}`));
  expect(res.ok()).toBeTruthy();
  const json = await res.json();
  return json;
}

async function waitForBackendDownloadReady(
  page: Page,
  bookId: string,
  { minChapters = 1, timeoutMs = 120_000 }: { minChapters?: number; timeoutMs?: number } = {}
) {
  await expect
    .poll(async () => {
      const json = await expectChaptersBackendState(page, bookId);
      if (!json?.exists) return false;
      if (!Array.isArray(json?.chapters)) return false;
      if (json.chapters.length < minChapters) return false;
      return json.chapters.every((chapter: { duration?: number }) => Number(chapter.duration ?? 0) > 0);
    }, { timeout: timeoutMs })
    .toBe(true);

  const fullDownloadButton = page.getByRole('button', { name: /Full Download/i });
  await expect(fullDownloadButton).toBeVisible({ timeout: timeoutMs });
  await expect(fullDownloadButton).toBeEnabled({ timeout: timeoutMs });
}

async function withDownloadedFullAudiobook<T>(
  page: Page,
  fn: (args: { filePath: string; suggestedFilename: string }) => Promise<T>,
  timeoutMs = 60_000
): Promise<T> {
  const dl = await downloadFullAudiobook(page, timeoutMs);
  try {
    return await fn({ filePath: dl.filePath, suggestedFilename: dl.suggestedFilename });
  } finally {
    await dl.cleanup();
  }
}

async function waitForStableUiChapterCount(
  page: Page,
  { stableMs = 2000, timeoutMs = 30000 } = {}
): Promise<number> {
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  const startTime = Date.now();
  let lastCount = -1;
  let lastStableTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const currentCount = await chapterActionsButtons.count();
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      lastStableTime = Date.now();
    } else if (Date.now() - lastStableTime >= stableMs) {
      return currentCount;
    }
    await page.waitForTimeout(200);
  }

  return Math.max(lastCount, 0);
}

async function cancelGenerationIfVisible(page: Page): Promise<void> {
  const generationCard = page.locator('div', { hasText: 'Generating Audiobook' }).first();
  const cancelButton = generationCard.getByRole('button', { name: 'Cancel' });
  const isVisible = await cancelButton.isVisible({ timeout: 2000 }).catch(() => false);
  if (!isVisible) return;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await cancelButton.click({ timeout: 5000 });
      return;
    } catch {
      const cardGone = (await generationCard.count()) === 0;
      if (cardGone) return;
      await page.waitForTimeout(150);
    }
  }
}

async function resetAudiobookById(page: Page, bookId: string) {
  for (let i = 0; i < 3; i++) {
    try {
      await page.evaluate(async (id) => {
        const r = await fetch(`/api/audiobook?bookId=${id}`, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
      }, bookId);
      return;
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function resetAudiobookIfPresent(page: Page, bookId?: string) {
  // Prefer backend reset when bookId is available: deterministic and independent of modal timing.
  // Do not block on UI re-open during end-of-test cleanup, which can be flaky under load.
  if (bookId) {
    await resetAudiobookById(page, bookId);
    return;
  }

  const resetButtons = page.getByRole('button', { name: 'Reset' });
  const count = await resetButtons.count();

  if (count === 0) {
    return;
  }

  const resetButton = resetButtons.first();
  await resetButton.click();

  const resetDialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Reset Audiobook' }) })
    .first();
  await expect(resetDialog).toBeVisible({ timeout: 15_000 });
  const confirmReset = resetDialog.getByRole('button', { name: 'Reset' });
  await confirmReset.click();

  await expect(page.getByRole('button', { name: 'Start Generation' })).toBeVisible({ timeout: 60_000 });
}

test('exports full MP3 audiobook for PDF using mocked 10s TTS sample', async ({ page }, testInfo) => {
  // If the ONNX model does not exist, the Python worker has to download it (~130MB).
  // Wait up to 480 seconds to avoid timing out on the first run.
  if (!fs.existsSync(path.join(process.cwd(), 'docstore', 'model', 'PP-DocLayoutV3.onnx'))) {
    test.setTimeout(480_000);
  } else {
    test.setTimeout(180_000);
  }

  // Ensure TTS is mocked and app is ready
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text())); page.on('pageerror', error => console.log('BROWSER ERROR:', error)); await setupTest(page, testInfo);

  // Upload and open the sample PDF in the viewer
  await uploadAndDisplay(page, 'sample.pdf', {
    pdfReadyTimeoutMs: testInfo.timeout - 10_000,
  });

  // Capture the generated document/book id from the /pdf/[id] URL
  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  // Open the audiobook export modal from the header button
  await openExportModal(page);

  // While there are no chapters yet, we can still switch the container format.
  // Choose MP3 so we can validate MP3 duration end-to-end.
  await setContainerFormatToMP3(page);

  // Start generation; in test namespace mode the server returns tests/files/sample.mp3
  // for each generated chapter via generateTTSBuffer's test mock path.
  await startGeneration(page);

  // Wait for chapters list to appear and populate the logical chapter
  await waitForChaptersHeading(page);
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons).toHaveCount(1, { timeout: 120_000 });

  page.on('request', request => {
    if (request.url().includes('/api/audiobook')) {
      console.log('PLAYWRIGHT REQUEST:', request.method(), request.url(), request.headers());
    }
  });
  page.on('response', response => {
    if (response.url().includes('/api/audiobook')) {
      console.log('PLAYWRIGHT RESPONSE:', response.status(), response.url());
    }
  });

  // Trigger full download from the FRONTEND button and capture via Playwright's download API.
  // The button label can be "Full Download (MP3)" or "Full Download (M4B)" depending on
  // the server-side detected format, so match more loosely on the accessible name.
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    // Use ffprobe (same toolchain as the server) to validate the combined audio duration.
    // The TTS route is mocked to return a 10s sample.mp3 for each chapter.
    const durationSeconds = await getAudioDurationSeconds(filePath);
    // Duration must be within a reasonable window around 10 seconds to allow
    // for encoding variations and container overhead.
    expect(durationSeconds).toBeGreaterThan(8);
    expect(durationSeconds).toBeLessThan(120);
  });

  // Also check the chapter metadata API for consistency
  const json = await expectChaptersBackendState(page, bookId);
  expect(json.exists).toBe(true);
  expect(Array.isArray(json.chapters)).toBe(true);
  expect(json.chapters.length).toBeGreaterThanOrEqual(1);
  for (const ch of json.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  await resetAudiobookIfPresent(page, bookId);
});

test('exports partial MP3 audiobook for EPUB using mocked 10s TTS sample', async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text())); page.on('pageerror', error => console.log('BROWSER ERROR:', error)); await setupTest(page, testInfo);

  // Upload and open the sample EPUB in the viewer
  await uploadAndDisplay(page, 'sample.epub');

  // URL should now be /epub/[id]
  const bookId = await getBookIdFromUrl(page, 'epub');
  await resetAudiobookById(page, bookId);

  // Open the audiobook export modal from the header button
  await openExportModal(page);

  // Set container format to MP3
  await setContainerFormatToMP3(page);

  // Start generation
  await startGeneration(page);

  // Progress card should appear with a Cancel button while chapters are being generated
  const generationCard = page.locator('div', { hasText: 'Generating Audiobook' }).first();
  const cancelButton = generationCard.getByRole('button', { name: 'Cancel' });
  await expect(cancelButton).toBeVisible({ timeout: 60_000 });

  // UI-first readiness check: wait until at least one chapter row is visible before cancellation.
  await waitForChaptersHeading(page);
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons.first()).toBeVisible({ timeout: 60_000 });

  // Now cancel the in-flight generation
  await cancelGenerationIfVisible(page);

  // Cancellation is asynchronous: wait for generation to settle before asserting
  // that the inline progress card has disappeared.
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 30_000 });
  await expect(generationCard).toHaveCount(0, { timeout: 30_000 });

  // Chapter list can continue updating briefly after cancellation; wait for UI count to stabilize.
  const chapterCountAfterCancel = await waitForStableUiChapterCount(page, { stableMs: 2000, timeoutMs: 30000 });
  expect(chapterCountAfterCancel).toBeGreaterThanOrEqual(1);

  // Keep assertions frontend-driven: chapter rows should remain visible and usable.
  await expect(chapterActionsButtons.first()).toBeVisible({ timeout: 60_000 });

  // The Full Download button should still be available for the partially generated audiobook
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    expect(durationSeconds).toBeGreaterThan(9);
    expect(durationSeconds).toBeLessThan(1200);
  });

  await resetAudiobookIfPresent(page, bookId);
});

test('exports a single MP3 audiobook PDF page via chapters menu', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text())); page.on('pageerror', error => console.log('BROWSER ERROR:', error)); await setupTest(page, testInfo);
  await uploadAndDisplay(page, 'sample.pdf');

  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  await openExportModal(page);
  await setContainerFormatToMP3(page);
  await startGeneration(page);

  await waitForChaptersHeading(page);

  // Wait for at least one chapter row to appear (one "Chapter actions" button)
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons).toHaveCount(1, { timeout: 60_000 });

  // A completed chapter row can appear before the overall generation job becomes
  // idle. Wait until the completed audiobook controls are available before
  // opening its action menu.
  await waitForBackendDownloadReady(page, bookId, { minChapters: 1 });

  // Verify the single-chapter download action is exposed. WebKit handles direct
  // MP3 links in its media plug-in rather than emitting a Playwright download,
  // so close the menu before validating the portable full-download path below.
  await chapterActionsButtons.nth(0).click();
  const downloadLink = page.getByRole('menuitem', { name: 'Download' });
  await expect(downloadLink).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(downloadLink).toHaveCount(0);

  // Download via full-download button once at least one chapter is ready.
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    expect(durationSeconds).toBeGreaterThan(8);
    expect(durationSeconds).toBeLessThan(120);
  });

  await resetAudiobookIfPresent(page, bookId);
});

test('resets all MP3 audiobook PDF pages', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text())); page.on('pageerror', error => console.log('BROWSER ERROR:', error)); await setupTest(page, testInfo);
  await uploadAndDisplay(page, 'sample.pdf');

  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  await openExportModal(page);
  await setContainerFormatToMP3(page);
  await startGeneration(page);

  await waitForChaptersHeading(page);

  // UI-first readiness check: wait for at least one chapter row.
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons.first()).toBeVisible({ timeout: 120_000 });

  // Reset is shown only while generation is idle; cancel any in-flight work first.
  const generationCard = page.locator('div', { hasText: 'Generating Audiobook' }).first();
  await cancelGenerationIfVisible(page);
  await expect(generationCard).toHaveCount(0, { timeout: 60_000 });

  // Wait for Reset button to become visible, indicating resumable/generated state
  const resetButton = page.getByRole('button', { name: 'Reset' });
  await expect(resetButton).toBeVisible({ timeout: 120_000 });

  await resetButton.click();

  // Confirm in the Reset Audiobook dialog
  await expect(page.getByRole('heading', { name: 'Reset Audiobook' })).toBeVisible({ timeout: 15000 });
  const confirmReset = page.getByRole('button', { name: 'Reset' }).last();
  await confirmReset.click();

  // After reset, generation should be startable again
  await expect(page.getByRole('button', { name: 'Start Generation' })).toBeVisible({ timeout: 60_000 });
  await expect(chapterActionsButtons).toHaveCount(0);
});

test('regenerates a single MP3 audiobook PDF page and exports full audiobook', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text())); page.on('pageerror', error => console.log('BROWSER ERROR:', error)); await setupTest(page, testInfo);
  await uploadAndDisplay(page, 'sample.pdf');

  // Extract bookId from /pdf/[id] URL (for backend verification later)
  const bookId = await getBookIdFromUrl(page, 'pdf');
  await resetAudiobookById(page, bookId);

  // Open Export Audiobook modal
  await openExportModal(page);

  // Set container format to MP3
  await setContainerFormatToMP3(page);

  // Start generation
  await startGeneration(page);

  // Wait for chapters to appear
  await waitForChaptersHeading(page);

  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await expect(chapterActionsButtons).toHaveCount(1, { timeout: 60_000 });

  // Cache the backend chapter count to ensure regeneration doesn't duplicate rows
  const backendStateBefore = await expectChaptersBackendState(page, bookId);
  const chapterCountBefore = backendStateBefore.chapters.length;

  // The chapter row can complete just before the overall job changes to idle.
  // Regeneration is intentionally unavailable until that transition finishes.
  await waitForBackendDownloadReady(page, bookId, { minChapters: chapterCountBefore });

  // Trigger regenerate on the first chapter
  await chapterActionsButtons.nth(0).click();
  const regenerateBtn = page.getByRole('menuitem', { name: 'Regenerate' });
  await expect(regenerateBtn).toBeVisible();
  await regenerateBtn.click();

  // Wait for it to finish regenerating. We expect the progress modal or spinner to appear and disappear.
  // The simplest check is waiting for the row actions button to be re-enabled or visible again.
  await expect(chapterActionsButtons.nth(0)).toBeVisible({ timeout: 60_000 });
  await expect(chapterActionsButtons).toHaveCount(1, { timeout: 60_000 });

  // Small delay to allow DB/UI state to settle after generation
  await page.waitForTimeout(2000);

  // Assert backend state is valid post-regeneration
  const backendStateAfterRegenerate = await expectChaptersBackendState(page, bookId);
  expect(backendStateAfterRegenerate.exists).toBe(true);
  expect(backendStateAfterRegenerate.chapters.length).toBe(chapterCountBefore);
  for (const ch of backendStateAfterRegenerate.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  // Chapter count should remain exactly the same after regeneration (no duplicates)
  await expect(chapterActionsButtons).toHaveCount(chapterCountBefore, { timeout: 20_000 });

  // Full Download should still work and produce a valid combined audiobook
  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    expect(durationSeconds).toBeGreaterThan(8);
    expect(durationSeconds).toBeLessThan(120);
  });

  // Backend should still report the same number of chapters and valid durations
  const json = await expectChaptersBackendState(page, bookId);
  expect(json.exists).toBe(true);
  expect(Array.isArray(json.chapters)).toBe(true);
  expect(json.chapters.length).toBe(chapterCountBefore);
  for (const ch of json.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  await resetAudiobookIfPresent(page, bookId);
});

test('resumes audiobook when a chapter is missing and full download succeeds (EPUB)', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text())); page.on('pageerror', error => console.log('BROWSER ERROR:', error)); await setupTest(page, testInfo);
  await uploadCompactRecoveryEpub(page);

  const bookId = await getBookIdFromUrl(page, 'epub');
  await resetAudiobookById(page, bookId);

  await openExportModal(page);
  await setContainerFormatToMP3(page);
  await startGeneration(page);

  await waitForChaptersHeading(page);
  const chapterActionsButtons = page.getByRole('button', { name: 'Chapter actions' });
  await waitForBackendDownloadReady(page, bookId, { minChapters: 3 });
  const beforeDelete = await expectChaptersBackendState(page, bookId);
  const chapterCountBefore = beforeDelete.chapters.length;
  expect(chapterCountBefore).toBe(3);
  await expect(chapterActionsButtons).toHaveCount(3, { timeout: 20_000 });

  // Delete the first chapter via the backend API so the audiobook has a missing index (0).
  // This is more reliable than clicking through the chapter actions menu in headless runs.
  const deleteRes = await requestWithRetry(() =>
    page.request.delete(`/api/audiobook/chapter?bookId=${bookId}&chapterIndex=0`)
  );
  expect(deleteRes.ok()).toBeTruthy();

  // Wait for backend to reflect the missing chapter 0.
  await expect
    .poll(async () => {
      const json = await expectChaptersBackendState(page, bookId);
      return json.chapters?.some((ch: any) => ch.index === 0) ?? false;
    }, { timeout: 30_000 })
    .toBe(false);

  const jsonAfterDelete = await expectChaptersBackendState(page, bookId);
  expect(jsonAfterDelete.exists).toBe(true);
  expect(Array.isArray(jsonAfterDelete.chapters)).toBe(true);
  // Do not assert exact length here because the background worker may have appended a new chapter.
  expect(jsonAfterDelete.chapters.some((ch: any) => ch.index === 0)).toBe(false);

  // Close and reopen the modal to ensure "resume" loads the missing placeholder from the backend.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'Export Audiobook' })).toHaveCount(0);
  await openExportModal(page);

  await waitForChaptersHeading(page);
  await expect(page.getByText(/Missing •/)).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible({ timeout: 15_000 });

  // Resume should regenerate the missing chapter and allow a full download to succeed.
  await page.getByRole('button', { name: 'Resume' }).click();

  // Progress/Generating state should complete and the "Resume" button should disappear.
  await expect(page.getByRole('button', { name: 'Resume' })).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText(/Missing •/)).toHaveCount(0, { timeout: 15_000 });

  // The original compact chapter set should be restored.
  await expect(chapterActionsButtons).toHaveCount(chapterCountBefore, { timeout: 20_000 });

  await withDownloadedFullAudiobook(page, async ({ filePath }) => {
    const durationSeconds = await getAudioDurationSeconds(filePath);
    expect(durationSeconds).toBeGreaterThan(chapterCountBefore * 8);
    expect(durationSeconds).toBeLessThan(chapterCountBefore * 35);
  });

  const jsonAfterResume = await expectChaptersBackendState(page, bookId);
  expect(jsonAfterResume.exists).toBe(true);
  expect(Array.isArray(jsonAfterResume.chapters)).toBe(true);
  expect(jsonAfterResume.chapters.length).toBe(chapterCountBefore);
  for (const ch of jsonAfterResume.chapters) {
    expect(ch.duration).toBeGreaterThan(0);
  }

  await resetAudiobookIfPresent(page, bookId);
});
