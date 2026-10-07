import { test, expect, type Page } from '@playwright/test';

// Render the real Next.js page/components. All browser APIs are intercepted;
// these interaction tests never enqueue production TTS/AI jobs or modify books.
async function setupReview(page: Page, options: { flags?: boolean; job?: boolean; drama?: boolean; delayedSave?: boolean; delayedPoll?: boolean } = {}) {
  await page.addInitScript(() => localStorage.setItem('cookie-consent', 'declined'));
  const chapters = [
    { index: 2, title: 'Opening', format: 'mp3', hasAudio: true },
    { index: 7, title: 'Needs attention', format: 'mp3', hasAudio: false, hasFailure: true },
    { index: 9, title: 'Closing', format: 'mp3', hasAudio: true },
  ];
  const texts: Record<number, string> = { 2: options.drama ? '<voice name="af_bella">Hello there.</voice>\n<voice name="af_heart">Second speaker.</voice>' : 'Opening text.', 7: 'Needs attention text.', 9: 'Closing text.' };
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  let textLoads = 0;
  let releasePoll: (() => void) | undefined;
  let pollWaiting = false;
  let saveFails = false;
  let releaseSave: (() => void) | undefined;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : null;
    requests.push({ path: pathname, method: request.method(), body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (pathname.includes('/auth/get-session')) return json({ user: { id: 'review-fixture', name: 'Reviewer', email: 'review@example.test', isAnonymous: false }, session: { id: 'fixture', expiresAt: '2099-01-01T00:00:00.000Z', userId: 'review-fixture' } });
    if (pathname === '/api/audiobook/status') return json({ chapters });
    if (pathname === '/api/audiobook/text') {
      const index = Number(url.searchParams.get('chapterIndex'));
      if (!url.searchParams.get('type') && index === 2 && ++textLoads === 2 && options.delayedPoll) {
        pollWaiting = true;
        await new Promise<void>(resolve => { releasePoll = resolve; });
      }
      return route.fulfill({ contentType: 'text/plain', body: url.searchParams.get('type') === 'original' ? `Original ${index}.` : texts[index] ?? '' });
    }
    if (pathname === '/api/audiobook/chapter') {
      if (request.method() === 'POST') {
        if (options.delayedSave) await new Promise<void>(resolve => { releaseSave = resolve; });
        if (saveFails) return json({ error: 'Recording could not be saved' }, 503);
        texts[Number(body?.chapterIndex)] = String(body?.text);
        return json({ success: true });
      }
      return route.fulfill({ status: 404, body: '' }); // no real media requests
    }
    if (pathname === '/api/tts-settings') return json({ smartAudioProfiles: [{ id: 'profile', name: 'Biblical Scholarship', aiModel: 'test-model', workerMode: options.drama ? 'multi-voice' : 'standard', abbreviations: {}, books: {}, pronunciations: {}, customTtsPrompt: '' }], selectedSmartAudioProfileId: 'profile' });
    if (pathname === '/api/audiobooks/batch-regenerate') return json(body?.dryRun ? { needsRegeneration: [{ modifiedChunks: 2 }] } : { success: true });
    if (pathname === '/api/audiobooks/fix-abbreviations-all') return json({ modifiedCount: 0 });
    if (pathname === '/api/audiobooks/queue') return json({ jobs: options.job ? [{ id: 'job-fixture', documentId: 'review-fixture', status: 'running', progress: 46, settingsJson: { jobType: 'batch-refine', batchRefineRunId: 'run-fixture' } }] : [] });
    if (pathname === '/api/audiobook/review-flags') return json({ flags: options.flags ? [
      { id: 'other', chapterIndex: 9, timestampMs: 0, createdAt: 1, kind: 'cloud-tts-failed', reason: 'Other chapter reason' },
      { id: 'current', chapterIndex: 7, timestampMs: 0, createdAt: 1, kind: 'cloud-tts-failed', reason: 'Current chapter reason', sourceText: 'Needs attention text.' },
    ] : [] });
    if (pathname.endsWith('/settings')) return json({ settings: { smartAudioCharacters: { profileId: 'profile', entries: { Bethany: { name: 'Bethany', description: 'Main speaker', sampleText: 'Hello there.', voiceId: 'af_bella', aliasFor: null } } } } });
    if (pathname.includes('/preferences')) return json({ preferences: {} });
    if (pathname.includes('/tts/providers')) return json({ providers: [] });
    if (pathname.includes('/documents')) return json({ documents: [] });
    return json({});
  });
  await page.goto('/listen/review-fixture');
  await expect(page.getByRole('heading', { name: 'Review: Opening', exact: true })).toBeVisible({ timeout: 90000 });
  await expect(page.getByRole('textbox', { name: 'Edited chapter text' })).toHaveValue(texts[2]);
  return { requests, failSave: () => { saveFails = true; }, releaseSave: () => releaseSave?.(), pollWaiting: () => pollWaiting, releasePoll: () => releasePoll?.() };
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'Edited chapter text' });
const next = (page: Page) => page.getByRole('button', { name: 'Next chapter', exact: true });
const dialog = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Unsaved changes' }) });

test('dirty Next: stay preserves edits, discard navigates, sparse chapter identity preserved', async ({ page }) => {
  const fixture = await setupReview(page);
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toHaveCount(0);
  await editor(page).fill('Unsaved opening edit.');
  await next(page).click();
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay Here' }).click();
  await expect(editor(page)).toHaveValue('Unsaved opening edit.');
  await expect(page.getByRole('heading', { name: 'Review: Opening' })).toBeVisible();
  await next(page).click();
  await dialog(page).getByRole('button', { name: 'Discard Changes' }).click();
  await expect(editor(page)).toHaveValue('Needs attention text.');
  expect(fixture.requests.filter(r => r.path === '/api/audiobook/chapter' && r.method === 'POST')).toHaveLength(0);
});

test('chapter selection and filtered selection use the same guard', async ({ page }) => {
  await setupReview(page);
  await editor(page).fill('Keep this edit.');
  await page.getByRole('button', { name: /Chunk 10 Closing/ }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay Here' }).click();
  await page.getByRole('button', { name: 'Needs Review (1)', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay Here' }).click();
  await expect(editor(page)).toHaveValue('Keep this edit.');
  // A status poll must not reopen the dialog or discard the edit.
  await page.waitForTimeout(5100);
  await expect(dialog(page)).toHaveCount(0);
  await expect(editor(page)).toHaveValue('Keep this edit.');
});

test('Save & Re-record waits for successful save before pending navigation', async ({ page }) => {
  const fixture = await setupReview(page, { delayedSave: true });
  await editor(page).fill('Saved opening edit.');
  await next(page).click();
  await dialog(page).getByRole('button', { name: 'Save & Re-record' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Re-recording…' })).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'Review: Opening' })).toBeVisible();
  fixture.releaseSave();
  await expect(editor(page)).toHaveValue('Needs attention text.');
  expect(fixture.requests.find(r => r.path === '/api/audiobook/chapter' && r.method === 'POST')?.body).toMatchObject({ chapterIndex: 2, text: 'Saved opening edit.' });
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toHaveCount(0);
});

test('failed save retains edits and pending dialog', async ({ page }) => {
  const fixture = await setupReview(page);
  fixture.failSave();
  await editor(page).fill('Never discard this.');
  await next(page).click();
  await dialog(page).getByRole('button', { name: 'Save & Re-record' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Save & Re-record' })).toBeEnabled();
  await expect(editor(page)).toHaveValue('Never discard this.');
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay Here' }).click();
  await expect(page.getByRole('heading', { name: 'Review: Opening' })).toBeVisible();
});

test('desktop panes remain independent; menus expose scope and conditional diagnostics', async ({ page }) => {
  await setupReview(page);
  const layout = page.getByRole('group', { name: 'Desktop pane visibility' });
  for (const name of ['List', 'Original', 'Edit']) await expect(layout.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await layout.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Chapters pane' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Original pane' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Edit pane' })).toBeVisible();
  await layout.getByRole('button', { name: 'List', exact: true }).click();
  await layout.getByRole('button', { name: 'Original', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Chapters pane' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Original pane' })).toBeHidden();
  await layout.getByRole('button', { name: 'Original', exact: true }).click();
  await layout.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Original pane' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Edit pane' })).toBeHidden();
  await layout.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Book Tools', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Book Tools' });
  await expect(menu.getByRole('menuitem', { name: 'Force Re-record All…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Pronunciation / Dictionary…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Book Tools', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Chapter Tools', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'View error log' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Re-record chapter' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Chunk 8 Needs attention/ }).click();
  await expect(editor(page)).toHaveValue('Needs attention text.');
  await page.getByRole('button', { name: 'Chapter Tools', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'View error log' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log', exact: true })).toHaveCount(0);
});

test('current issues first, other issues behind disclosure, compact active-job overflow', async ({ page }) => {
  await setupReview(page, { flags: true, job: true });
  await page.getByRole('button', { name: /Chunk 8 Needs attention/ }).click();
  await expect(page.getByRole('region', { name: 'Review issues' })).toContainText('1 issue in this chapter · 2 total');
  await expect(page.getByText('Current chapter reason', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review Issues', exact: true }).click();
  await expect(page.getByText('Reason: Current chapter reason', { exact: true })).toBeVisible();
  await expect(page.getByText('Reason: Other chapter reason', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show 1 other book issues' }).click();
  await expect(page.getByText('Reason: Other chapter reason', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh review issues' })).toBeVisible();
  await page.getByRole('button', { name: 'Review Issues', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop & Cancel' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Background job tools' }).click();
  await expect(page.getByRole('menuitem', { name: 'Raw Changelog' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Stop & Cancel' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Book Tools', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Review AI Changes' })).toHaveCount(0);
});

test('AI clean dialog preserves edited/original target and profile with unchanged API payload', async ({ page }) => {
  const fixture = await setupReview(page);
  await page.getByRole('button', { name: /AI Clean( Chapter)?…/ }).click();
  const clean = page.getByRole('dialog');
  await expect(clean.getByRole('radio', { name: /Edited text/ })).toBeChecked();
  await clean.getByRole('radio', { name: /Original text/ }).check();
  await expect(clean.getByRole('combobox', { name: 'Profile' })).toHaveValue('profile');
  await clean.getByRole('button', { name: 'Clean Chapter', exact: true }).click();
  await expect(clean).toHaveCount(0);
  expect(fixture.requests.find(r => r.path === '/api/audiobook/chapter' && r.method === 'POST')?.body).toMatchObject({ chapterIndex: 2, text: 'Original 2.', useSmartAudio: true, settings: { smartAudioProfileId: 'profile', scholarAutoScan: true } });
});

test('mobile displays one pane, usable audio action, dirty save, no desktop studio', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setupReview(page);
  await expect(page.getByRole('region', { name: 'Edit pane' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Original pane' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Chapters pane' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review Audio', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Audio Drama Studio' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'Chapters', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Chapters pane' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Edit pane' })).toBeHidden();
  await page.getByRole('radio', { name: 'Original', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Original pane' })).toBeVisible();
  await page.getByRole('radio', { name: 'Original', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Edit', exact: true })).toHaveAttribute('aria-checked', 'true');
  await editor(page).fill('Mobile change.');
  await expect(editor(page)).toHaveValue('Mobile change.');
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});

test('speaker drafts are guarded and applied once without blur silently resetting other edits', async ({ page }) => {
  const fixture = await setupReview(page, { drama: true });
  await expect(page.getByRole('button', { name: 'Audio Drama Studio' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Apply Changes/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Text for speaker segment 2' }).fill('Other speaker edit.');
  await page.getByRole('textbox', { name: 'Text for speaker segment 1' }).fill('New speaker text.');
  await expect(page.getByRole('button', { name: /Apply Changes/ })).toBeVisible();
  await next(page).click();
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Stay Here' }).click();
  await expect(page.getByRole('textbox', { name: 'Text for speaker segment 1' })).toHaveValue('New speaker text.');
  await expect(page.getByRole('textbox', { name: 'Text for speaker segment 2' })).toHaveValue('Other speaker edit.');
  await page.getByRole('button', { name: /Apply Changes/ }).click();
  await expect(page.getByRole('button', { name: /Apply Changes/ })).toHaveCount(0);
  const recording = fixture.requests.find(r => r.path === '/api/audiobook/chapter' && r.method === 'POST')?.body;
  expect(recording?.text).toContain('New speaker text.');
  expect(recording?.text).toContain('Other speaker edit.');
});


test('book maintenance commands preserve their handlers and force recording requires confirmation', async ({ page }) => {
  const fixture = await setupReview(page);
  const book = () => page.getByRole('button', { name: 'Book Tools', exact: true }).click();
  await book();
  await page.getByRole('menuitem', { name: 'Fix All Abbreviations', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(r => r.path === '/api/audiobooks/fix-abbreviations-all')).toHaveLength(1);
  expect(fixture.requests.find(r => r.path === '/api/audiobooks/fix-abbreviations-all')?.body).toMatchObject({ bookId: 'review-fixture', smartAudioProfileId: 'profile' });
  await book();
  await page.getByRole('menuitem', { name: 'Re-record Modified Chapters', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(r => r.path === '/api/audiobooks/batch-regenerate')).toHaveLength(2);
  await book();
  await page.getByRole('menuitem', { name: 'Force Re-record All…', exact: true }).click();
  const force = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Force Re-record All?' }) });
  await expect(force.getByRole('heading')).toBeVisible();
  expect(fixture.requests.some(r => r.body?.forceAll)).toBe(false);
  await force.getByRole('button', { name: 'Force Re-record All', exact: true }).click();
  await expect.poll(() => fixture.requests.filter(r => r.body?.forceAll)).toHaveLength(1);
});

test('responsive/dark-mode QA: compact chrome, visible workspace, focus, no horizontal overflow', async ({ page }, testInfo) => {
  await setupReview(page, { flags: true, job: true });
  await page.getByRole('button', { name: /Chunk 8 Needs attention/ }).click();
  await expect(editor(page)).toHaveValue('Needs attention text.');
  for (const width of [1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(editor(page)).toBeVisible();
    if (width >= 768) {
      const header = await page.getByLabel('Chapter review', { exact: true }).boundingBox();
      const tools = await page.getByLabel('Chapter workspace tools').boundingBox();
      const job = await page.getByRole('region', { name: 'Background job' }).boundingBox();
      expect((header?.height ?? 0) + (tools?.height ?? 0)).toBeLessThanOrEqual(112);
      expect(job?.height).toBeLessThanOrEqual(48);
    }
    await page.screenshot({ path: testInfo.outputPath(`review-${width}-light.png`) });
    await page.evaluate(() => { document.documentElement.classList.remove('light'); document.documentElement.classList.add('dark'); });
    await page.getByRole('button', { name: 'Chapter Tools', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'View error log' })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.screenshot({ path: testInfo.outputPath(`review-${width}-dark-menu.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Chapter Tools', exact: true })).toBeFocused();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.classList.add('light'); });
  }
});


test('an in-flight background text response cannot overwrite newly typed edits', async ({ page }) => {
  const fixture = await setupReview(page, { delayedPoll: true });
  await expect.poll(fixture.pollWaiting, { timeout: 10000 }).toBe(true);
  await editor(page).fill('Typed while the poll was pending.');
  fixture.releasePoll();
  await expect(editor(page)).toHaveValue('Typed while the poll was pending.');
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toBeVisible();
  // Allow the released fetch response to commit before checking again.
  await page.waitForTimeout(200);
  await expect(editor(page)).toHaveValue('Typed while the poll was pending.');
});


test('dirty multi-voice layout stays compact at desktop/tablet widths, with Studio available', async ({ page }) => {
  await setupReview(page, { drama: true });
  await editor(page).fill('<voice name="af_bella">Changed text.</voice>');
  for (const width of [1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const tools = await page.getByLabel('Chapter workspace tools').boundingBox();
    expect(tools?.height).toBeLessThanOrEqual(48);
    if (width >= 1024) await expect(page.getByRole('button', { name: 'Audio Drama Studio', exact: true })).toBeVisible();
    else {
      await page.getByRole('button', { name: 'Chapter Tools', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Audio Drama Studio', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
  }
});
