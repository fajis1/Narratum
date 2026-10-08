import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

for (const mode of ['complete', 'manual', 'retry', 'resume', 'bulk', 'override', 'override-individual', 'diagnostics']) test(`scan carries repair through approval (${mode})`, async ({ page }) => {
  const partial = mode === 'manual' || mode === 'retry' || mode.startsWith('override');
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // Exercise the actual React modals with fixture APIs: no paid AI/TTS calls
  // and no writes to a user's audiobook are needed for this interaction test.
  const bundle = await build({
    stdin: { contents: `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {PronunciationIssuesModal} from './src/components/audiobooks/PronunciationIssuesModal';
      function App() { const [open,setOpen]=useState(true); const [queued,setQueued]=useState(0);
        return <><button onClick={()=>setOpen(true)}>Open scan</button><span data-testid="queued">{queued}</span>
        <PronunciationIssuesModal open={open} onClose={()=>setOpen(false)} bookId="fixture-book" profileId="fixture-profile" onRecordingQueued={()=>setQueued(n=>n+1)}/></>; }
      createRoot(document.getElementById('root')).render(<App/>);`, loader: 'tsx', resolveDir: process.cwd() },
    bundle: true, write: false, outfile: '/tmp/pronunciation-issues-fixture.js', format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': path.join(process.cwd(), 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
  });
  const proposedFiles: string[] = [];
  let queued = false;
  let queuedSettings: Record<string, unknown> = {};
  let approved = false;
  let recordingComplete = false;
  const recordingRetries: string[] = [];
  const approvedIds: string[] = [];
  const approvalOverrides: boolean[] = [];
  const recordingVoices: string[] = [];
  let remembered = false;
  let retried = false;
  let resumed = false;
  let resumeSettings: Record<string, unknown> = {};
  await page.route('http://localhost/**', async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' });
    if (url.pathname === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text });
    if (url.pathname.endsWith('/pronunciation-issues')) {
      if (url.searchParams.get('action') === 'review-status') return json({ repairs: queued ? [
        ...(mode === 'bulk' ? ['failed-one', 'failed-two'].map((changeId, index) => ({ changeId, runId: `${changeId}-run`, fileName: `02${index}0__text.txt`, chapterIndex: 200 + index, title: `Failed recording ${index}`, decision: 'approved', audioStatus: recordingRetries.includes(changeId) ? 'queued' : 'error', ready: false, unresolvedCount: 0 })) : []),
        { changeId: 'change', runId: 'fixture-run', fileName: '0107__text.txt', chapterIndex: 106, title: 'Aetherian chapter', decision: approved ? 'approved' : 'pending', audioStatus: recordingComplete ? 'completed' : approved ? 'queued' : 'not_requested', ready: !approved && (!partial || retried), unresolvedCount: partial && !retried ? 1 : 0 },
        ...(mode === 'bulk' ? [{ changeId: 'partial', runId: 'partial-run', fileName: '0108__text.txt', chapterIndex: 107, title: 'Partial chapter', decision: 'pending', audioStatus: 'not_requested', ready: false, unresolvedCount: 1 }] : []),
        ...(mode === 'bulk' ? [{ changeId: 'second-ready', runId: 'second-run', fileName: '0109__text.txt', chapterIndex: 108, title: 'Second ready chapter', decision: approved ? 'approved' : 'pending', audioStatus: recordingComplete ? 'completed' : approved ? 'queued' : 'not_requested', ready: !approved, unresolvedCount: 0 }] : []),
      ] : [] });
      if (url.searchParams.get('action') === 'report') return route.fulfill({ contentType: 'application/json', headers: { 'Content-Disposition': 'attachment; filename="pronunciation-repair-fixture-job.json"' }, body: JSON.stringify({ jobId: 'fixture-job', summary: { failures: 0, proposals: 1 } }) });
      if (url.searchParams.get('action') === 'config') return json({ selectedProfileId: 'fixture-profile', recordingVoice: 'af_heart', recordingVoices: ['af_heart', 'am_adam'], modelFallbacks: { 'gemini-3.8-flash': ['gemini-3.7-flash', 'gemini-3.6-flash'], 'gemini-3.7-flash': ['gemini-3.6-flash', 'gemini-3.5-flash'] }, profiles: [{ id: 'fixture-profile', name: 'Scholar', model: 'gemini-3.8-flash', primaryKeyRef: 'fixture-profile:primary', backupKeyRef: '' }], keySources: [{ ref: 'fixture-profile:primary', label: 'Scholar primary', masked: '...1111' }, { ref: 'other:primary', label: 'Other primary', masked: '...2222' }] });
      if (url.searchParams.get('action') === 'jobs') return json({ jobs: queued ? [{ id: 'fixture-job', status: mode === 'resume' && !resumed ? 'error' : 'completed', progress: 100, total: 1, results: [{ fileName: '0107__text.txt', runId: 'fixture-run', requestId: 'fixture-request', apiBlocked: mode === 'resume' && !resumed, unresolvedCount: partial && !retried ? 1 : 0 }] }] : [] });
      if (route.request().method() === 'GET') return json({ chapters: [{ fileName: '0107__text.txt', chapterIndex: 106, failed: false }, { fileName: '0108__text.txt', chapterIndex: 107, failed: false }], failedJobs: [] });
      const body = route.request().postDataJSON();
      if (body.action === 'remember-approved') { remembered = true; return json({ saved: 2, alreadyKnown: 0, skipped: 1 }); }
      if (body.action === 'resume-repairs') { resumed = true; resumeSettings = body; return json({ jobId: 'fixture-job' }); }
      if (body.action === 'scan' && mode === 'diagnostics') {
        const matched = body.fileName === '0107__text.txt';
        return json({ fileName: body.fileName, chapterIndex: matched ? 106 : 107, title: 'Aetherian chapter', hash: 'fixture-hash', failed: false,
          issues: matched ? [] : [{ id: '0', start: 4, end: 34, text: '[Aetherian](/bad split/)', context: 'The Aetherian arrived.', reason: 'Pronunciation cannot be aligned.' }],
          overrideDiagnostic: { version: 'pronunciation-override-rescan:v1', requestId: matched ? 'matched-reference' : 'changed-reference', status: matched ? 'matched' : 'text_changed', scannedText: 'saved_chapter', strictIssueCount: matched ? 2 : 1, acknowledgedIssueCount: matched ? 2 : 0, actionableIssueCount: matched ? 0 : 1 } });
      }
      if (body.action === 'scan' && queued && partial) return json({ fileName: body.fileName, hash: 'fixture-hash', retryRunId: 'fixture-run', proposalHash: 'current-proposal-hash', issues: [{ id: '0', text: 'θεῷ', start: 40, end: 43 }] });
      if (body.action === 'scan') return json({ fileName: body.fileName, chapterIndex: body.fileName === '0107__text.txt' ? 106 : 107, title: 'Aetherian chapter', hash: 'fixture-hash', failed: false,
        issues: body.fileName === '0107__text.txt' ? [{ id: '0', start: 4, end: 34, text: '[Aetherian](/bad split/)', context: 'The Aetherian arrived.', reason: 'Pronunciation cannot be aligned.', replacement: '[Aetherian](/eɪθɪriən/)' }] : [] });
      if (body.action === 'queue') { queued = true; queuedSettings = body; retried = Boolean(body.chapters[0].retryRunId); proposedFiles.push(...body.chapters.map((chapter: { fileName: string }) => chapter.fileName)); return json({ jobId: 'fixture-job' }); }
    }
    if (url.pathname.endsWith('/batch-refine/review')) {
      if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'retry') {
        recordingRetries.push(route.request().postDataJSON().changeId); recordingVoices.push(route.request().postDataJSON().recordingVoice); return json({ success: true });
      }
      if (route.request().method() === 'POST') { approved = true; approvalOverrides.push(route.request().postDataJSON().overridePronunciationReview === true); approvedIds.push(route.request().postDataJSON().changeId); recordingVoices.push(route.request().postDataJSON().recordingVoice); return json({ success: true }); }
      return json({ run: { id: 'fixture-run', rule: 'pronunciation-repair:v1', status: 'completed', processedChapters: 1, totalChapters: 1 },
        changes: [{ id: 'change', textFileName: '0107__text.txt', chapterIndex: 106, chapterTitle: 'Aetherian chapter', previousText: 'The [Aetherian](/bad split/) arrived.', proposedText: 'The [Aetherian](/eɪθɪriən/) arrived.' + (partial ? retried ? ' [θεῷ](/θeɪoʊ/)' : ' θεῷ' : ''), reviewNote: partial && !retried ? 'NEEDS REVIEW: unresolved passage.' : null, diffText: '-bad split\n+eɪθɪriən', changedCharacters: 10, changePercent: 20, reviewPriority: 'high', priorityScore: 70, decision: approved ? 'approved' : 'pending', audioStatus: approved ? 'queued' : 'not_requested' }], flagDefinitions: [] });
    }
    return route.fulfill({ status: 404, body: 'Unexpected fixture request' });
  });
  await page.goto('http://localhost/');
  await expect.poll(async () => pageErrors.length + await page.getByRole('button', { name: 'Start Scan', exact: true }).count()).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
  await expect(page.getByLabel('Repair AI model')).toHaveValue('gemini-3.8-flash');
  await expect(page.getByLabel('Repair fallback model 1')).toHaveValue('gemini-3.7-flash');
  await expect(page.getByLabel('Repair fallback model 2')).toHaveValue('gemini-3.6-flash');
  await expect(page.getByLabel('Pronunciation repair recording voice')).toHaveValue('af_heart');
  await page.getByLabel('Pronunciation repair recording voice').selectOption('am_adam');
  await page.getByLabel('Repair AI model', { exact: true }).selectOption('gemini-3.7-flash');
  await expect(page.getByLabel('Repair AI model', { exact: true })).toHaveValue('gemini-3.7-flash');
  await page.getByLabel('Repair AI model', { exact: true }).selectOption('gemini-3.8-flash');
  await expect(page.getByLabel('Repair AI model', { exact: true })).toHaveValue('gemini-3.8-flash');
  await page.getByLabel('Repair AI model', { exact: true }).selectOption('custom');
  await page.getByLabel('Custom repair AI model', { exact: true }).fill('custom-fixture-model');
  await page.getByLabel('Repair fallback model 1').selectOption('gemini-3.7-flash');
  await page.getByLabel('Repair fallback model 2').selectOption('gemini-3.6-flash');
  await page.getByLabel('Repair fallback model 1').selectOption('');
  await expect(page.getByLabel('Repair fallback model 2')).toBeDisabled();
  await expect(page.getByLabel('Repair fallback model 2')).toHaveValue('');
  await page.getByLabel('Repair fallback model 1').selectOption('gemini-3.6-flash');
  await page.getByLabel('Repair fallback model 2').selectOption('gemini-3.7-flash');
  await page.getByLabel('Primary Gemini key', { exact: true }).selectOption('other:primary');
  await page.getByRole('button', { name: 'Start Scan', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Propose Repairs (1)' })).toBeEnabled();
  await expect(page.getByText('Checked 2 chapter text files.', { exact: false })).toBeVisible();
  if (mode === 'diagnostics') {
    await page.getByText('Override scan diagnostics (2 chapters)', { exact: true }).click();
    await expect(page.locator('li').filter({ hasText: 'Chapter 107' }).filter({ hasText: 'Override matched' })).toBeVisible();
    await expect(page.getByText('Reference: matched-reference', { exact: true })).toBeVisible();
    await expect(page.getByText(/Text changed — Override does not apply/)).toBeVisible();
    const downloadPending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download scan log' }).click();
    const download = await downloadPending;
    expect(download.suggestedFilename()).toBe('pronunciation-override-scan-log.json');
    const stream = await download.createReadStream(); const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const logText = Buffer.concat(chunks).toString('utf8');
    const log = JSON.parse(logText);
    expect(log.scans.map((scan: { diagnostic: { status: string } }) => scan.diagnostic.status)).toEqual(['matched', 'text_changed']);
    expect(log.scans[0].diagnostic).toMatchObject({ acknowledgedIssueCount: 2, actionableIssueCount: 0 });
    expect(logText).not.toContain('Aetherian');
    expect(logText).not.toContain('primaryKeyRef');
    expect(pageErrors).toEqual([]);
    return;
  }
  await page.getByRole('button', { name: 'Propose Repairs (1)' }).click();
  await expect(page.getByText('Repairs queued.', { exact: false })).toBeVisible();
  // A reload must restore durable progress and the proposal review link.
  await page.reload();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download repair report' }).click();
  const reportDownload = await downloaded;
  expect(reportDownload.suggestedFilename()).toBe('pronunciation-repair-fixture-job.json');
  expect(await reportDownload.failure()).toBeNull();
  const reportStream = await reportDownload.createReadStream();
  const reportChunks: Buffer[] = [];
  for await (const chunk of reportStream!) reportChunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(reportChunks).toString('utf8'))).toMatchObject({ jobId: 'fixture-job', summary: { proposals: 1 } });
  if (mode === 'retry') {
    await page.getByRole('button', { name: 'Retry unresolved', exact: true }).click();
    await expect.poll(() => retried).toBe(true);
    expect(queuedSettings.chapters).toEqual([{ fileName: '0107__text.txt', hash: 'fixture-hash', retryRunId: 'fixture-run', proposalHash: 'current-proposal-hash' }]);
  }
  if (mode === 'resume') {
    await page.getByLabel('Repair AI model', { exact: true }).selectOption('gemini-3.7-flash');
    await page.getByLabel('Repair fallback model 1').selectOption('gemini-3.6-flash');
    await page.getByLabel('Repair fallback model 2').selectOption('');
    await page.getByRole('button', { name: 'Resume pending repairs', exact: true }).click();
    await expect.poll(() => resumed).toBe(true);
    expect(resumeSettings).toMatchObject({ action: 'resume-repairs', jobId: 'fixture-job', aiModel: 'gemini-3.7-flash', fallbackModels: ['gemini-3.6-flash'] });
    await expect(page.getByRole('button', { name: 'Review & Approve' })).toBeEnabled();
  }
  if (mode === 'bulk') {
    await expect(page.getByRole('button', { name: 'Retry all failed recordings (2)', exact: true })).toBeEnabled();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Retry all failed recordings (2)', exact: true }).click();
    expect(recordingRetries).toEqual([]);
    await expect(page.getByText('Awaiting approval', { exact: true })).toHaveCount(2);
    await expect(page.getByText('Needs review', { exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Approve all ready repairs (2)', exact: true }).click();
    await expect(page.getByText('Recording queued', { exact: true })).toHaveCount(2);
    expect(approvedIds).toEqual(['change', 'second-ready']);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Remember approved pronunciations', exact: true }).click();
    await expect(page.getByText('Remembered 2 pronunciations for this book;', { exact: false })).toBeVisible();
    expect(remembered).toBe(true);
    await expect(page.getByRole('button', { name: 'Approve all ready repairs (0)' })).toBeDisabled();
    recordingComplete = true;
    await expect(page.getByText('Complete', { exact: true })).toHaveCount(2, { timeout: 10000 });
    await page.reload();
    await expect(page.getByText('Complete', { exact: true })).toHaveCount(2);
    await expect(page.getByText('Needs review', { exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Retry all failed recordings (2)', exact: true }).click();
    await expect(page.getByText('2 recordings queued.', { exact: false })).toBeVisible();
    expect(recordingRetries).toEqual(['failed-one', 'failed-two']);
    expect(recordingVoices).toEqual(['am_adam', 'am_adam', 'am_adam', 'am_adam']);
    expect(approvedIds).toEqual(['change', 'second-ready']);
    await expect(page.getByRole('button', { name: 'Retry all failed recordings (0)', exact: true })).toBeDisabled();
    expect(pageErrors).toEqual([]);
    return;
  }
  if (mode.startsWith('override')) {
    await expect(page.getByRole('checkbox', { name: /^Override/ })).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Approve all ready repairs (0)' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /^Override/ }).check();
    if (mode === 'override') {
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('button', { name: 'Accept all proposals with Override (1)' }).click();
      expect(approvedIds).toEqual([]);
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Accept all proposals with Override (1)' }).click();
      await expect(page.getByTestId('queued')).toHaveText('1');
      expect(approvalOverrides).toEqual([true]);
      await page.reload();
      await expect(page.getByRole('checkbox', { name: /^Override/ })).not.toBeChecked();
      return;
    }
  }
  await page.getByRole('button', { name: 'Review & Approve' }).click();
  await expect(page.getByRole('heading', { name: 'Pronunciation Repair Review' })).toBeVisible();
  if (mode === 'override-individual') {
    await page.getByRole('button', { name: 'Approve with Override & Record', exact: true }).click();
    await expect(page.getByTestId('queued')).toHaveText('1');
    expect(approvalOverrides).toEqual([true]);
    return;
  }
  if (mode === 'manual') {
    await expect(page.getByText('Needs review: 1 unresolved passages.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve & Record', exact: true })).toBeDisabled();
    await page.getByLabel('Replacement for θεῷ').fill('[θεῷ](/θeɪoʊ/)');
    await page.getByRole('button', { name: 'Apply only to this issue', exact: true }).click();
    await expect(page.getByLabel('Full chapter proposal')).toHaveValue('The [Aetherian](/eɪθɪriən/) arrived. [θεῷ](/θeɪoʊ/)');
    await page.getByRole('button', { name: 'Approve Edit & Record', exact: true }).click();
  } else await page.getByRole('button', { name: 'Approve & Record', exact: true }).click();
  await expect(page.getByTestId('queued')).toHaveText('1');
  expect(proposedFiles).toEqual(mode === 'retry' ? ['0107__text.txt', '0107__text.txt'] : ['0107__text.txt']);
  if (mode !== 'retry') expect(queuedSettings).toMatchObject({ aiModel: 'custom-fixture-model', fallbackModels: ['gemini-3.6-flash', 'gemini-3.7-flash'], primaryKeyRef: 'other:primary', backupKeyRef: '' });
  expect(approved).toBe(true);
  expect(recordingVoices).toEqual(['am_adam']);
});
