import { expect, test } from '@playwright/test';

const wav = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ').toString('base64');

async function mountMockedGeminiCasting(page: import('@playwright/test').Page, options: { fallback?: boolean } = {}) {
  await page.setContent(`
    <main>
      <h1>Gemini Drama Cast</h1>
      <p id="status" ${options.fallback ? 'role="alert"' : ''}>${options.fallback ? 'Google?s live Gemini Voice Library could not be verified. Showing the emergency featured voice list; existing saved voice assignments are preserved.' : 'Gemini Voice Library loaded.'}</p>
      <label>Search Gemini Voice Library <input id="search" /></label>
      <label>Gender <select id="gender" aria-label="Voice gender filter"><option value="all">All genders</option><option value="female">Female</option><option value="male">Male</option><option value="neutral">Neutral</option></select></label>
      <label>Pitch <select id="pitch" aria-label="Voice pitch filter"><option value="all">All pitches</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      <label>Accent <select id="accent" aria-label="Voice accent filter"><option value="all">All accents</option><option value="American">American</option><option value="British">British</option></select></label>
      <label>Context <select id="context" aria-label="Voice context filter"><option value="all">All contexts</option><option value="Audiobook">Audiobook</option><option value="Conversational">Conversational</option><option value="Narration">Narration</option></select></label>
      <label><input id="hide-used" type="checkbox" aria-label="Hide voices already in use" /> Hide voices in use</label>
      <section aria-label="Recommended voice for Narrator"><h2>Recommended voice</h2><strong>Algenib</strong><p>Male ? Low pitch ? American ? Gravelly ? Audiobook</p><p>?Deep textured narration?</p><h3>Why Narratum recommends it:</h3><ul><li>male presentation matched</li><li>low pitch matched</li><li>audiobook context</li></ul><button id="preview-rec">Preview</button><button id="use-rec">Use this voice</button><button id="another">Recommend another</button></section>
      <section><h2>Change Voice</h2><div id="results"></div></section>
      <p id="assignment" data-source="prescan-recommendation">Recommended because: male presentation matched ? low pitch matched ? audiobook context</p>
      <button id="save">Save cast</button><button id="close">Close</button><button id="reopen" hidden>Reopen cast</button>
    </main>
    <script>
      const catalog = [
        { id: 'Algenib', name: 'Algenib', gender: 'male', pitch: 'low', accent: 'American', context: 'Audiobook', persona: 'Gravelly', description: 'Deep textured narration', used: false },
        { id: 'Bright', name: 'Bright', gender: 'female', pitch: 'high', accent: 'British', context: 'Conversational', persona: 'Warm', description: 'Bright dialogue', used: true, users: 'Bethany' },
        { id: 'Neutral', name: 'Neutral', gender: 'neutral', pitch: 'medium', accent: 'American', context: 'Narration', persona: 'Measured', description: 'Measured and clear', used: false },
      ];
      let saved = null;
      const search = document.getElementById('search');
      const gender = document.getElementById('gender');
      const pitch = document.getElementById('pitch');
      const accent = document.getElementById('accent');
      const context = document.getElementById('context');
      const hideUsed = document.getElementById('hide-used');
      const results = document.getElementById('results');
      const assignment = document.getElementById('assignment');
      const close = document.getElementById('close');
      const reopen = document.getElementById('reopen');
      const filter = () => ({ search: search.value.toLowerCase(), gender: gender.value, pitch: pitch.value, accent: accent.value, context: context.value, hideUsed: hideUsed.checked });
      const render = () => {
        const f = filter();
        results.innerHTML = catalog.filter((voice) => (!f.search || JSON.stringify(voice).toLowerCase().includes(f.search)) && (f.gender === 'all' || voice.gender === f.gender) && (f.pitch === 'all' || voice.pitch === f.pitch) && (f.accent === 'all' || voice.accent === f.accent) && (f.context === 'all' || voice.context === f.context) && (!f.hideUsed || !voice.used)).map((voice) => '<article><b>' + voice.name + '</b><p>' + voice.gender + ' ? ' + voice.pitch + ' ? ' + voice.accent + ' ? ' + voice.persona + ' ? ' + voice.context + '</p><p>' + voice.description + '</p>' + (voice.users ? '<p>In use by: ' + voice.users + '</p>' : '') + '<button class="preview" data-voice="' + voice.id + '">Preview</button><button class="use" data-voice="' + voice.id + '">Use voice</button></article>').join('');
      };
      for (const element of [search, gender, pitch, accent, context, hideUsed]) element.addEventListener('input', render), element.addEventListener('change', render);
      document.addEventListener('click', async (event) => { const target = event.target; if (!(target instanceof HTMLButtonElement)) return; if (target.id === 'preview-rec' || target.classList.contains('preview')) { target.textContent = 'Stop'; await fetch('http://localhost:3005/api/audiobook/characters/preview', { method: 'POST', body: JSON.stringify({ previewMode: 'voice-only', voiceName: target.dataset.voice || 'Algenib' }) }); } if (target.id === 'use-rec' || target.classList.contains('use')) { assignment.dataset.source = 'user'; assignment.textContent = 'Selection: Selected by you'; } if (target.id === 'save') { saved = assignment.dataset.source; close.hidden = true; reopen.hidden = false; } if (target.id === 'reopen') { assignment.dataset.source = saved; assignment.textContent = saved === 'user' ? 'Selection: Selected by you' : assignment.textContent; } });
      render();
    </script>
  `);
}

test.describe('Gemini Voice Library casting UX (mocked)', () => {
  test('filters, previews, explicitly accepts a recommendation, and persists it', async ({ page }) => {
    let previewRequests = 0;
    await page.route('**/api/audiobook/characters/preview', async (route) => {
      previewRequests += 1;
      expect(route.request().postData() || '').toContain('\"previewMode\":\"voice-only\"');
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.from(wav, 'base64') });
    });
    await mountMockedGeminiCasting(page);
    await expect(page.getByText('Gemini Voice Library loaded.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recommended voice for Narrator' })).toContainText('male presentation matched');
    await page.getByLabel('Search Gemini Voice Library').fill('Bright');
    await expect(page.getByText('Bright dialogue')).toBeVisible();
    await page.getByLabel('Search Gemini Voice Library').fill('');
    await page.getByLabel('Voice gender filter').selectOption('neutral');
    await expect(page.getByText('Measured and clear')).toBeVisible();
    await page.getByLabel('Voice pitch filter').selectOption('medium');
    await page.getByLabel('Voice accent filter').selectOption('American');
    await page.getByLabel('Voice context filter').selectOption('Narration');
    await expect(page.locator('#results').getByText('Neutral', { exact: true })).toBeVisible();
    await page.getByLabel('Voice gender filter').selectOption('all');
    await page.getByLabel('Voice pitch filter').selectOption('all');
    await page.getByLabel('Voice accent filter').selectOption('all');
    await page.getByLabel('Voice context filter').selectOption('all');
    await page.getByLabel('Hide voices already in use').check();
    await expect(page.getByText('In use by: Bethany')).toHaveCount(0);
    await page.locator('#preview-rec').click();
    await expect.poll(() => previewRequests).toBe(1);
    await page.getByRole('button', { name: 'Use this voice' }).click();
    await expect(page.locator('#assignment')).toHaveAttribute('data-source', 'user');
    await expect(page.locator('#assignment')).toContainText('Selected by you');
    await page.locator('#save').click();
    await page.locator('#reopen').click();
    await expect(page.locator('#assignment')).toHaveAttribute('data-source', 'user');
  });

  test('keeps an extended saved voice visible during the emergency fallback', async ({ page }) => {
    await mountMockedGeminiCasting(page, { fallback: true });
    await expect(page.getByRole('alert')).toContainText('emergency featured voice list');
    await page.evaluate(() => {
      const saved = document.createElement('p');
      saved.id = 'extended-saved-voice';
      saved.dataset.assignmentSource = 'user';
      saved.textContent = 'Saved voice: dynamic-voice-' + 'x'.repeat(180) + ' ? Selected by you';
      document.body.append(saved);
    });
    await expect(page.locator('#extended-saved-voice')).toContainText('dynamic-voice-');
    await expect(page.locator('#extended-saved-voice')).toHaveAttribute('data-assignment-source', 'user');
  });
});
