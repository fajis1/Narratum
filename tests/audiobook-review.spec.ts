import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

// Render the real Next.js page/components. All browser APIs are intercepted;
// these interaction tests never enqueue production TTS/AI jobs or modify books.
async function setupReview(page: Page, options: { flags?: boolean; job?: boolean; jobType?: string; cleanedText?: string; drama?: boolean; delayedSave?: boolean; delayedPoll?: boolean; globalDrama?: boolean; bookDrama?: boolean; noBookProfile?: boolean; pronunciationText?: string; savedPronunciationIssue?: boolean; approvedOverrideTextHash?: string } = {}) {
  await page.addInitScript(() => localStorage.setItem('cookie-consent', 'declined'));
  const chapters = [
    { index: 2, title: 'Opening', format: 'mp3', hasAudio: true },
    { index: 7, title: 'Needs attention', format: 'mp3', hasAudio: false, hasFailure: true },
    { index: 9, title: 'Closing', format: 'mp3', hasAudio: true },
  ];
  const texts: Record<number, string> = { 2: options.drama ? '<voice name="af_bella">Hello there.</voice>\n<voice name="af_heart">Second speaker.</voice>' : options.pronunciationText || 'Opening text.', 7: 'Needs attention text.', 9: 'Closing text.' };
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
    if (pathname === '/api/audiobook/status') return json({ chapters, settings: options.noBookProfile ? null : { smartAudioProfileId: 'profile', useSmartAudio: true } });
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
        texts[Number(body?.chapterIndex)] = body?.useSmartAudio && options.cleanedText ? options.cleanedText : String(body?.text);
        return json({ success: true });
      }
      return route.fulfill({ status: 404, body: '' }); // no real media requests
    }
    if (pathname === '/api/tts-settings') return json({ smartAudioProfiles: [{ id: 'profile', name: 'Biblical Scholarship', aiModel: 'test-model', workerMode: options.bookDrama ? 'drama-gemini-tts' : options.drama ? 'multi-voice' : 'standard', abbreviations: {}, books: {}, pronunciations: {}, customTtsPrompt: '' }, ...(options.globalDrama ? [{ id: 'global-drama', name: 'Global Drama', aiModel: 'test-model', workerMode: 'drama-gemini-tts', abbreviations: {}, books: {}, pronunciations: {}, customTtsPrompt: '' }] : [])], selectedSmartAudioProfileId: options.globalDrama ? 'global-drama' : 'profile' });
    if (pathname === '/api/audiobooks/pronunciation-issues') return json({ repairs: options.approvedOverrideTextHash ? [{ changeId: 'approved-change', runId: 'approved-run', fileName: '0003__text.txt', chapterIndex: 2, title: 'Opening', decision: 'approved', audioStatus: 'completed', unresolvedCount: 0, ready: false, approvedOverrideTextHash: options.approvedOverrideTextHash }] : options.savedPronunciationIssue ? [{ changeId: 'pronunciation-change', runId: 'pronunciation-run', fileName: '0010__text.txt', chapterIndex: 9, title: 'Closing', decision: 'pending', audioStatus: 'not_requested', unresolvedCount: 2, ready: false }] : [] });
    if (pathname === '/api/audiobook/drama-segments') return json({ review: null });
    if (pathname === '/api/audiobooks/batch-regenerate') return json(body?.dryRun ? { needsRegeneration: [{ modifiedChunks: 2 }] } : { success: true });
    if (pathname === '/api/audiobooks/fix-abbreviations-all') return json({ modifiedCount: 0 });
    if (pathname === '/api/audiobooks/queue') return json({ jobs: options.job ? [{ id: 'job-fixture', documentId: 'review-fixture', status: 'running', progress: 46, settingsJson: { jobType: options.jobType || 'batch-refine', ...(options.jobType && options.jobType !== 'batch-refine' ? {} : { batchRefineRunId: 'run-fixture' }) } }] : [] });
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
  if (options.bookDrama) await expect(page.getByText('Gemini Drama · Speaker Review', { exact: true })).toBeVisible();
  else await expect(page.getByRole('textbox', { name: 'Edited chapter text' })).toHaveValue(texts[2]);
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

async function openDirtyClean(page: Page, original = false) {
  await editor(page).fill('My unsaved edit.');
  await page.getByRole('button', { name: 'AI Clean Chapter…', exact: true }).click();
  if (original) await page.getByRole('radio', { name: /Original text/ }).check();
  await page.getByRole('button', { name: 'Clean Chapter', exact: true }).click();
}

test('AI Clean reconciles authoritative text, dirty state, and audio revision', async ({ page }) => {
  await setupReview(page, { cleanedText: 'Authoritative cleaned text.' });
  const before = await page.locator('audio').first().getAttribute('src');
  await openDirtyClean(page);
  await expect(editor(page)).toHaveValue('Authoritative cleaned text.');
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toHaveCount(0);
  await expect(page.locator('audio').first()).not.toHaveAttribute('src', before!);
});

test('AI Clean preserves typing made while request is pending', async ({ page }) => {
  const fixture = await setupReview(page, { delayedSave: true, cleanedText: 'Server cleaned text.' });
  await openDirtyClean(page);
  await expect.poll(() => fixture.requests.filter(r => r.path === '/api/audiobook/chapter' && r.method === 'POST').length).toBe(1);
  await page.keyboard.press('Escape');
  await editor(page).fill('Newer local typing.');
  fixture.releaseSave();
  await expect(page.getByText('Chapter cleaned and audio refreshed.')).toBeVisible();
  await expect(editor(page)).toHaveValue('Newer local typing.');
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(editor(page)).toHaveValue('Server cleaned text.');
});

test('Original clean requires confirmation and Go Back preserves edits', async ({ page }) => {
  const fixture = await setupReview(page, { cleanedText: 'Cleaned original.' });
  await openDirtyClean(page, true);
  await expect(page.getByRole('heading', { name: 'Clean from Original text?' })).toBeVisible();
  expect(fixture.requests.filter(r => r.path === '/api/audiobook/chapter' && r.method === 'POST')).toHaveLength(0);
  await page.getByRole('button', { name: 'Go Back' }).click();
  await page.getByRole('button', { name: 'Clean Chapter', exact: true }).click();
  await page.getByRole('button', { name: 'Clean from Original', exact: true }).click();
  await expect(editor(page)).toHaveValue('Cleaned original.');
  expect(fixture.requests.find(r => r.path === '/api/audiobook/chapter' && r.method === 'POST')?.body?.text).toBe('Original 2.');
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toHaveCount(0);
});

test('failed AI Clean retains dirty editor and recoverable dialog', async ({ page }) => {
  const fixture = await setupReview(page);
  fixture.failSave();
  await openDirtyClean(page);
  await expect(page.getByText(/AI Clean failed \(503\)/)).toBeVisible();
  await expect(editor(page)).toHaveValue('My unsaved edit.');
  await expect(page.getByRole('button', { name: 'Clean Chapter', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Save & Re-record', exact: true })).toBeVisible();
});

test('dirty book operations are disabled and unknown AI review is hidden', async ({ page }) => {
  await setupReview(page);
  await editor(page).fill('Unsaved chapter.');
  await page.getByRole('button', { name: 'Book Tools', exact: true }).click();
  for (const name of ['Fix All Abbreviations', 'AI Batch Refine…', 'Re-record Modified Chapters', 'Force Re-record All…', 'Scan Pronunciation Issues', 'Add to Audiobookshelf']) await expect(page.getByRole('menuitem', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Review AI Changes', exact: true })).toHaveCount(0);
});

test('pronunciation job has correct label and no batch-only controls', async ({ page }) => {
  await setupReview(page, { job: true, jobType: 'pronunciation-repair' });
  await expect(page.getByRole('status').filter({ hasText: 'Pronunciation Repair' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review Changes', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Background job tools' }).click();
  await expect(page.getByRole('link', { name: 'Raw Changelog' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Book Tools', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /AI Batch Refine/ })).toBeDisabled();
});


test('normal book ignores global Drama selection; missing book profile also stays a normal editor', async ({ page }) => {
  const fixture = await setupReview(page, { globalDrama: true });
  await expect(editor(page)).toBeVisible();
  await expect(page.getByText('Gemini Drama · Speaker Review', { exact: true })).toHaveCount(0);
  expect(fixture.requests.filter(request => request.path === '/api/audiobook/drama-segments')).toHaveLength(0);
  await page.getByRole('button', { name: 'AI Clean Chapter…', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Profile', exact: true })).toHaveValue('profile');
  await page.keyboard.press('Escape');
  await setupReview(page, { globalDrama: true, noBookProfile: true });
  await expect(editor(page)).toBeVisible();
  await expect(page.getByText('Gemini Drama · Speaker Review', { exact: true })).toHaveCount(0);
});

test('a saved Gemini Drama book still opens its speaker review', async ({ page }) => {
  await setupReview(page, { bookDrama: true });
  await expect(page.getByText('This chapter has no saved Gemini speaker assignments yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare speaker review', exact: true })).toBeVisible();
});

test('pronunciation issues slowly cycle both controls ten times and disappear when fixed', async ({ page }) => {
  await setupReview(page, { pronunciationText: 'The Θ edition has περι.' });
  const book = page.getByRole('button', { name: 'Book Tools', exact: true });
  await expect(book).toHaveAttribute('data-pronunciation-attention', 'true');
  const animation = await book.evaluate(element => { const style = getComputedStyle(element); return { name: style.animationName, duration: style.animationDuration, iterations: style.animationIterationCount }; });
  expect(animation.name).not.toBe('none'); expect(animation.duration).toBe('4s'); expect(animation.iterations).toBe('10');
  await page.getByRole('button', { name: 'Needs Review (2)', exact: true }).click();
  await expect(page.getByRole('button', { name: /Chunk 3.*Pronunciation: 2/ })).toBeVisible();
  await book.click();
  const scan = page.getByRole('menuitem', { name: 'Scan Pronunciation Issues', exact: true });
  await expect(scan).toHaveAttribute('data-pronunciation-attention', 'true');
  expect(await scan.evaluate(element => getComputedStyle(element).animationIterationCount)).toBe('10');
  await page.keyboard.press('Escape');
  await editor(page).fill('The [Θ](/θeɪtə/) edition has [περι](/pɛri/).');
  await expect(book).not.toHaveAttribute('data-pronunciation-attention', 'true');
});

test('saved pronunciation proposals signal Book Tools without confusing ordinary TTS flags', async ({ page }) => {
  await setupReview(page, { savedPronunciationIssue: true });
  await expect(page.getByRole('button', { name: 'Book Tools', exact: true })).toHaveAttribute('data-pronunciation-attention', 'true');
  await expect(page.getByRole('button', { name: /Chunk 10.*Pronunciation: 2/ })).toBeVisible();
  await setupReview(page, { flags: true });
  await expect(page.getByRole('button', { name: 'Book Tools', exact: true })).not.toHaveAttribute('data-pronunciation-attention', 'true');
});

test('reduced motion keeps a static pronunciation warning', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setupReview(page, { pronunciationText: 'Read περι.' });
  const book = page.getByRole('button', { name: 'Book Tools', exact: true });
  await expect(book).toHaveAttribute('data-pronunciation-attention', 'true');
  expect(await book.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
});


test('approved Override keeps exact saved text unflagged; new edits restore pronunciation warnings', async ({ page }) => {
  const text = 'Read [περι](/pɛr/) and α\u0313.';
  await setupReview(page, { pronunciationText: text, approvedOverrideTextHash: createHash('sha256').update(text, 'utf8').digest('hex') });
  const book = page.getByRole('button', { name: 'Book Tools', exact: true });
  await page.waitForTimeout(500);
  await expect(book).not.toHaveAttribute('data-pronunciation-attention', 'true');
  for (const changed of [text + ' New edit.', text.normalize('NFC')]) {
    await editor(page).fill(changed);
    await expect(book).toHaveAttribute('data-pronunciation-attention', 'true');
    await editor(page).fill(text);
    await expect(book).not.toHaveAttribute('data-pronunciation-attention', 'true');
  }
});


test('Review Home is visible on desktop and mobile and returns to the dashboard', async ({ page }) => {
  await setupReview(page);
  const home = page.getByRole('button', { name: 'Home', exact: true });
  await expect(home).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(home).toBeVisible();
  await home.click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30000 });
});

test('Review Home guards unsaved edits: Stay preserves them and Discard leaves', async ({ page }) => {
  await setupReview(page);
  await editor(page).fill('Keep my chapter edits.');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await page.getByRole('button', { name: 'Stay Here', exact: true }).click();
  await expect(page).toHaveURL(/\/listen\/review-fixture$/);
  await expect(editor(page)).toHaveValue('Keep my chapter edits.');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Discard Changes', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30000 });
});

test('Review Home only continues after Save & Re-record succeeds', async ({ page }) => {
  const fixture = await setupReview(page);
  await editor(page).fill('Save before returning home.');
  fixture.failSave();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save & Re-record', exact: true }).click();
  await expect(page.getByText('Recording could not be saved', { exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('heading', { name: 'Unsaved changes' })).toBeVisible();
  await expect(editor(page)).toHaveValue('Save before returning home.');
  await expect(page).toHaveURL(/\/listen\/review-fixture$/);
  await page.getByRole('button', { name: 'Stay Here', exact: true }).click();
  await setupReview(page);
  await editor(page).fill('Successfully saved before leaving.');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Save & Re-record', exact: true }).click();
  await expect(page).toHaveURL(/\/app$/, { timeout: 30000 });
});
