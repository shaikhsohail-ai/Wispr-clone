import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * These tests run against the built web app served by the real server with the mock
 * transcription engine. Chromium's fake microphone supplies the audio, so the complete
 * capture → upload → clean-up → save → copy pipeline is exercised end to end.
 */

async function useMockEngine(page: Page, extra: (page: Page) => Promise<void> = async () => undefined) {
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('engine-select').selectOption('mock');
  await page.getByTestId('spoken-punctuation').selectOption('on');
  await extra(page);
  await page.getByTestId('tab-history').click();
  await expect(page.getByTestId('engine-chip')).toHaveText('Mock engine');
}

/** Make the app believe the server can polish, without an Anthropic key: /api/polish is then routed per test. */
async function enablePolish(page: Page) {
  await page.route('**/api/health', async (route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...json, polish: true, polishModel: 'fake-model' } });
  });
}

/** Hold the Space hotkey for `ms` milliseconds (the fake microphone supplies the audio). */
async function holdSpace(page: Page, ms: number) {
  await page.keyboard.down('Space');
  await expect(page.getByTestId('mic-button')).toHaveAttribute('data-phase', 'listening');
  await page.waitForTimeout(ms);
  await page.keyboard.up('Space');
}

const openRow = (page: Page, text: string) =>
  page
    .getByTestId('history-item')
    .filter({ hasText: text })
    .getByRole('button', { name: /Open dictation/ });

test.beforeEach(async ({ page }) => {
  await page.request.delete('/api/dictations');
  await page.goto('/');
  await expect(page.getByTestId('server-status')).toContainText('Server connected');
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
});

test('hold the hotkey, speak, release: the dictation is cleaned, saved and copied', async ({ page }) => {
  await useMockEngine(page);
  const mic = page.getByTestId('mic-button');

  await page.keyboard.down('Space');
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await expect(page.getByTestId('live-status')).toContainText('Listening');
  await page.waitForTimeout(1500);
  await page.keyboard.up('Space');

  await expect(page.getByTestId('transcript-result')).toBeVisible();
  await expect(mic).toHaveAttribute('data-phase', 'done');
  const text = await page.getByTestId('result-text').inputValue();
  expect(text).toMatch(/^This is a mock transcription of your audio\. It worked! \d+\.\d seconds of audio received\.$/);
  await expect(page.getByTestId('raw-text')).toContainText('um this is a mock transcription of your audio period');

  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(page.getByTestId('history-item').first()).toContainText('Mock engine');
  await expect(page.getByTestId('stat-count')).toHaveText('1');
  await expect(page.getByTestId('stat-words')).toHaveText('15');

  await expect(page.getByTestId('toast').first()).toContainText('Copied');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(text);

  const stored = await page.request.get('/api/dictations').then((r) => r.json());
  expect(stored.total).toBe(1);
  expect(stored.items[0].engine).toBe('mock');
  expect(stored.items[0].durationMs).toBeGreaterThan(1000);
});

test('the microphone button works with the pointer and Escape cancels a recording', async ({ page }) => {
  await useMockEngine(page);
  const mic = page.getByTestId('mic-button');

  await page.keyboard.down('Space');
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await page.keyboard.press('Escape');
  await expect(mic).toHaveAttribute('data-phase', 'idle');
  await page.keyboard.up('Space');
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(0);

  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await expect(page.getByTestId('transcript-result')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
});

test('a tap that is too short gives a friendly error instead of an empty dictation', async ({ page }) => {
  await useMockEngine(page);
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  const error = page.getByTestId('transcript-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/too short|never started|still starting/i);
  await expect(page.getByTestId('retry-button')).toHaveCount(0); // nothing was captured, so there is nothing to resend
  await error.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(0);
});

test('toggle mode starts on one press and finishes on the next', async ({ page }) => {
  await useMockEngine(page, async (p) => {
    await p.getByLabel('Press to start / stop').check();
  });
  const mic = page.getByTestId('mic-button');
  await page.keyboard.press('Space');
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('transcript-result')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
});

test('history can be searched, opened, edited, exported and deleted', async ({ page }) => {
  await page.request.post('/api/dictations', { data: { text: 'Buy milk and eggs.', engine: 'mock', durationMs: 4000 } });
  await page.request.post('/api/dictations', { data: { text: 'Call the dentist tomorrow.', engine: 'webspeech', durationMs: 5000 } });
  await page.reload();
  await expect(page.getByTestId('history-item')).toHaveCount(2);
  await expect(page.getByTestId('stat-count')).toHaveText('2');

  await page.getByTestId('history-search').fill('dentist');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await page
    .getByTestId('history-item')
    .first()
    .getByRole('button', { name: /Open dictation/ })
    .click();
  await expect(page.getByTestId('result-text')).toHaveValue('Call the dentist tomorrow.');

  await page.getByTestId('result-text').fill('Call the dentist on Monday.');
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('history-item').first()).toContainText('Call the dentist on Monday.');
  await expect(page.getByTestId('save-button')).toHaveCount(0);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-txt').click()]);
  expect(download.suggestedFilename()).toMatch(/^dictations-\d{4}-\d{2}-\d{2}\.txt$/);
  const exported = readFileSync((await download.path())!, 'utf8');
  expect(exported).toContain('Call the dentist on Monday.');
  expect(exported).toContain('Buy milk and eggs.');

  await page.getByTestId('delete-button').click();
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
  await page.getByTestId('history-search').fill('');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(page.getByTestId('history-item').first()).toContainText('Buy milk and eggs.');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('clear-all').click();
  await expect(page.getByTestId('history-empty')).toBeVisible();
  await expect(page.getByTestId('stat-count')).toHaveText('0');
});

test('settings persist across reloads and drive the on-screen hints', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('hotkey-select').selectOption('f8');
  await page.getByTestId('auto-copy').uncheck();
  await page.getByTestId('dictionary-add').click();
  await page.getByLabel('Heard as').fill('wisper');
  await page.getByLabel('Replace with').fill('Wispr');
  await page.reload();
  await expect(page.locator('.hero-hint')).toContainText('Hold F8 to talk');
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('hotkey-select')).toHaveValue('f8');
  await expect(page.getByTestId('auto-copy')).not.toBeChecked();
  await expect(page.getByLabel('Heard as')).toHaveValue('wisper');
  await expect(page.getByLabel('Replace with')).toHaveValue('Wispr');
});

test('the polish button is disabled until the server has an Anthropic key', async ({ page }) => {
  await page.request.post('/api/dictations', { data: { text: 'Something to polish.', engine: 'mock', durationMs: 1000 } });
  await page.reload();
  await page
    .getByTestId('history-item')
    .first()
    .getByRole('button', { name: /Open dictation/ })
    .click();
  await expect(page.getByTestId('polish-button')).toBeDisabled();
  await expect(page.getByTestId('polish-button')).toHaveAttribute('title', /ANTHROPIC_API_KEY/);
});

test('a hold that begins while the previous dictation is still processing starts once it settles', async ({ page }) => {
  await useMockEngine(page);
  await page.route('**/api/transcribe**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const mic = page.getByTestId('mic-button');

  await holdSpace(page, 1200);
  await expect(mic).toHaveAttribute('data-phase', 'transcribing');
  await expect(page.locator('.hero-hint')).toContainText('Working on it');

  // The next sentence: the key goes down while the first one is still being transcribed and stays down.
  await page.keyboard.down('Space');
  for (let i = 0; i < 6; i++) {
    await page.dispatchEvent('body', 'keydown', { key: ' ', code: 'Space', repeat: true, bubbles: true });
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(mic).toHaveAttribute('data-phase', 'listening'); // re-armed by the held key once the run settled
  await page.waitForTimeout(1200);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('history-item')).toHaveCount(2);
});

test('a hold released before the previous run finishes does not start a recording', async ({ page }) => {
  await useMockEngine(page);
  await page.route('**/api/transcribe**', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const mic = page.getByTestId('mic-button');
  await holdSpace(page, 1200);
  await expect(mic).toHaveAttribute('data-phase', 'transcribing');
  await page.keyboard.down('Space');
  await page.waitForTimeout(300);
  await page.keyboard.up('Space');
  await expect(mic).toHaveAttribute('data-phase', 'done');
  await page.waitForTimeout(600);
  await expect(mic).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
});

test('Escape while transcribing discards the late server response', async ({ page }) => {
  await useMockEngine(page);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/transcribe**', async (route) => {
    await held;
    await route.continue().catch(() => undefined); // the page already aborted this request
  });
  const mic = page.getByTestId('mic-button');
  await holdSpace(page, 800);
  await expect(mic).toHaveAttribute('data-phase', 'transcribing');
  await page.keyboard.press('Escape');
  await expect(mic).toHaveAttribute('data-phase', 'idle');
  release();
  await page.waitForTimeout(1000); // give a mishandled late response time to surface
  await expect(mic).toHaveAttribute('data-phase', 'idle');
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
  await expect(page.getByTestId('transcript-error')).toHaveCount(0);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await expect(page.getByTestId('history-item')).toHaveCount(0);
  expect((await page.request.get('/api/dictations').then((r) => r.json())).total).toBe(0);

  // The session recovers: a normal dictation afterwards works.
  await holdSpace(page, 1200);
  await expect(page.getByTestId('history-item')).toHaveCount(1);
});

test('the Cancel button in the live panel aborts a transcription (no keyboard needed)', async ({ page }) => {
  await useMockEngine(page, async (p) => {
    await p.getByLabel('Press to start / stop').check();
  });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/transcribe**', async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  const mic = page.getByTestId('mic-button');
  await page.keyboard.press('Space');
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await expect(page.getByTestId('cancel-button')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  await expect(mic).toHaveAttribute('data-phase', 'transcribing');
  await expect(page.getByTestId('live-status')).toContainText('Transcribing');
  await page.getByTestId('cancel-button').click();
  await expect(mic).toHaveAttribute('data-phase', 'idle');
  release();
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(0);
});

test('a failed transcription keeps the audio and Try again resends it', async ({ page }) => {
  await useMockEngine(page);
  let calls = 0;
  await page.route('**/api/transcribe**', (route) =>
    ++calls === 1
      ? route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'OpenAI transcription failed (429): Rate limit reached', code: 'engine_error' }),
        })
      : route.continue(),
  );
  const mic = page.getByTestId('mic-button');
  await holdSpace(page, 1200);
  const error = page.getByTestId('transcript-error');
  await expect(error).toContainText('Rate limit reached');
  await expect(mic).toHaveAttribute('data-phase', 'error');
  await expect(page.getByTestId('history-item')).toHaveCount(0);

  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('transcript-result')).toBeVisible();
  await expect(page.getByTestId('result-text')).toHaveValue(/^This is a mock transcription/);
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  expect(calls).toBe(2);
});

test('a server transcription failure shows the server message and the hotkey works again from the error panel', async ({ page }) => {
  await useMockEngine(page);
  let calls = 0;
  await page.route('**/api/transcribe**', (route) =>
    ++calls === 1
      ? route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal server error', code: 'internal' }),
        })
      : route.continue(),
  );
  const mic = page.getByTestId('mic-button');
  await holdSpace(page, 1200);
  await expect(page.getByTestId('transcript-error')).toContainText('Internal server error');
  await expect(mic).toHaveAttribute('data-phase', 'error');
  await expect(page.getByTestId('history-item')).toHaveCount(0);

  // Press the hotkey again straight from the error panel, without Dismiss.
  await holdSpace(page, 1200);
  await expect(page.getByTestId('transcript-error')).toHaveCount(0);
  await expect(page.getByTestId('transcript-result')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  expect(calls).toBe(2);
});

test('a microphone error that lands after the key was released keeps its specific message', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((_resolve, reject) => setTimeout(() => reject(new DOMException('Permission denied', 'NotAllowedError')), 600));
  });
  await page.reload();
  await useMockEngine(page);
  await page.keyboard.down('Space');
  await expect(page.getByTestId('mic-button')).toHaveAttribute('data-phase', 'listening');
  await page.waitForTimeout(100);
  await page.keyboard.up('Space');
  await expect(page.getByTestId('transcript-error')).toContainText(/Microphone access was blocked/);
});

test('Escape while the microphone is still opening releases it', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[]; __contexts: AudioContext[] };
    w.__streams = [];
    w.__contexts = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      await new Promise((r) => setTimeout(r, 1500)); // a slow device or an open permission prompt
      const stream = await original(constraints);
      w.__streams.push(stream);
      return stream;
    };
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.__contexts.push(this);
      }
    };
  });
  await page.reload();
  await useMockEngine(page);
  const mic = page.getByTestId('mic-button');
  await page.keyboard.down('Space');
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await expect(mic).toHaveAttribute('data-phase', 'idle');
  await page.keyboard.up('Space');
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => {
    const w = window as unknown as { __streams: MediaStream[]; __contexts: AudioContext[] };
    return {
      streams: w.__streams.length,
      tracks: w.__streams.flatMap((s) => s.getTracks().map((t) => t.readyState)),
      contexts: w.__contexts.map((c) => c.state),
    };
  });
  expect(state.streams).toBe(1);
  expect(state.tracks.every((t) => t === 'ended')).toBe(true);
  expect(state.contexts.every((c) => c === 'closed')).toBe(true);
});

test('when the automatic copy is refused the toast offers a Copy button that works', async ({ page }) => {
  await page.addInitScript(() => {
    // Firefox and Safari refuse a clipboard write that happens long after the last key press; emulate that once.
    let calls = 0;
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text: string) =>
      ++calls === 1 ? Promise.reject(new DOMException('No user gesture', 'NotAllowedError')) : original(text);
    document.execCommand = () => false;
  });
  await page.reload();
  await useMockEngine(page);
  await holdSpace(page, 1200);
  await expect(page.getByTestId('transcript-result')).toBeVisible();
  const toast = page.getByTestId('toast').filter({ hasText: /Press Copy/ });
  await expect(toast).toBeVisible();
  await toast.getByTestId('toast-action').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Copied to clipboard' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^This is a mock transcription/);
});

test('when saving to history fails the transcript is kept, marked Not saved, and Retry save stores it', async ({ page }) => {
  await useMockEngine(page);
  let failures = 1;
  await page.route(
    (url) => url.pathname === '/api/dictations',
    (route) =>
      route.request().method() === 'POST' && failures-- > 0
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full', code: 'internal' }) })
        : route.continue(),
  );
  const mic = page.getByTestId('mic-button');
  await holdSpace(page, 1200);
  const result = page.getByTestId('transcript-result');
  await expect(result).toContainText('Not saved');
  await expect(page.getByTestId('toast').filter({ hasText: /could not save/i })).toBeVisible();
  await expect(mic).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('history-item')).toHaveCount(0);

  // Edits are kept locally while the dictation is unsaved.
  await page.getByTestId('result-text').fill('Edited offline.');
  await page.getByTestId('save-button').click();
  await expect(page.getByTestId('result-text')).toHaveValue('Edited offline.');
  await expect(page.getByTestId('save-button')).toHaveCount(0);

  // Once the server is back, Retry save stores what is on screen.
  await page.getByTestId('retry-save-button').click();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(page.getByTestId('history-item').first()).toContainText('Edited offline.');
  await expect(page.getByTestId('transcript-result')).not.toContainText('Not saved');
  await expect(page.getByTestId('stat-count')).toHaveText('1');
  const stored = await page.request.get('/api/dictations').then((r) => r.json());
  expect(stored.total).toBe(1);
  expect(stored.items[0].text).toBe('Edited offline.');
});

test('Space typed into the search box or the transcript must not start a recording', async ({ page }) => {
  await useMockEngine(page);
  const search = page.getByTestId('history-search');
  await search.click();
  await page.keyboard.type('buy milk');
  await expect(search).toHaveValue('buy milk');
  await expect(page.getByTestId('mic-button')).toHaveAttribute('data-phase', 'idle');

  await page.request.post('/api/dictations', { data: { text: 'Edit me.', engine: 'mock', durationMs: 1000 } });
  await page.reload();
  await openRow(page, 'Edit me.').click();
  const area = page.getByTestId('result-text');
  await area.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' more words');
  await expect(area).toHaveValue('Edit me. more words');
  await expect(page.getByTestId('save-button')).toBeVisible();
  await expect(page.getByTestId('mic-button')).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('transcript-result')).toBeVisible();
});

test('with Ctrl + Space as the hotkey, a plain Space still operates a focused checkbox', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  await page.getByTestId('hotkey-select').selectOption('ctrl-space');
  const autoCopy = page.getByTestId('auto-copy');
  await expect(autoCopy).toBeChecked();
  await autoCopy.focus();
  await page.keyboard.press('Space');
  await expect(autoCopy).not.toBeChecked();
  await expect(page.getByTestId('mic-button')).toHaveAttribute('data-phase', 'idle');
});

test('the microphone button can be held from the keyboard and keeps focus while working', async ({ page }) => {
  await useMockEngine(page, async (p) => {
    await p.getByTestId('hotkey-select').selectOption('f8');
  });
  const mic = page.getByTestId('mic-button');
  await mic.focus();
  await page.keyboard.down('Enter');
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await page.waitForTimeout(1200);
  await page.keyboard.up('Enter');
  await expect(page.getByTestId('transcript-result')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(mic).toBeFocused(); // aria-disabled instead of disabled: focus survived the busy phase

  // An assistive-technology activation (a click without a pointer) toggles, since it cannot hold a key.
  await mic.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(mic).toHaveAttribute('data-phase', 'listening');
  await page.waitForTimeout(1200);
  await mic.evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('history-item')).toHaveCount(2);
});

test('phase changes are announced once; the running clock is not a live region', async ({ page }) => {
  await useMockEngine(page);
  const status = page.getByTestId('phase-status');
  const liveText = () =>
    page.evaluate(() => Array.from(document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).map((el) => el.textContent));
  await page.keyboard.down('Space');
  await expect(status).toHaveText('Listening');
  await expect(page.getByTestId('live-status')).toContainText('Listening');
  const before = await liveText();
  await page.waitForTimeout(1300);
  expect(await liveText()).toEqual(before);
  await page.keyboard.up('Space');
  await expect(status).toContainText('Dictation ready');
});

test('polishing uses the edited draft, marks it AI polished and patches history', async ({ page }) => {
  await enablePolish(page);
  const polishCalls: Array<{ text: string; mode: string }> = [];
  await page.route('**/api/polish', (route) => {
    const body = route.request().postDataJSON() as { text: string; mode: string };
    polishCalls.push(body);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: `Polished: ${body.text}`, mode: body.mode, model: 'fake-model' }),
    });
  });
  await page.request.post('/api/dictations', { data: { text: 'raw text here', engine: 'mock', durationMs: 1000 } });
  await page.reload();
  await openRow(page, 'raw text here').click();
  await expect(page.getByTestId('polish-button')).toBeEnabled();
  await page.getByTestId('result-text').fill('raw text here, edited');
  await expect(page.getByTestId('save-button')).toBeVisible();
  await page.getByTestId('polish-mode').selectOption('formal');
  await page.getByTestId('polish-button').click();
  await expect(page.getByTestId('result-text')).toHaveValue('Polished: raw text here, edited');
  await expect(page.getByTestId('transcript-result')).toContainText('AI polished');
  await expect(page.getByTestId('save-button')).toHaveCount(0);
  await expect(page.getByTestId('history-item').first()).toContainText('Polished: raw text here, edited');
  expect(polishCalls[0]).toMatchObject({ text: 'raw text here, edited', mode: 'formal' });
  expect(Array.isArray((polishCalls[0] as { dictionary?: unknown }).dictionary)).toBe(true);
  expect((await page.request.get('/api/dictations').then((r) => r.json())).items[0]).toMatchObject({
    text: 'Polished: raw text here, edited',
    polished: true,
  });
});

test('auto-polish falls back to the unpolished dictation when /api/polish fails', async ({ page }) => {
  await enablePolish(page);
  await page.route('**/api/polish', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Anthropic rate limit hit, try again in a moment', code: 'polish_rate_limited' }),
    }),
  );
  await page.reload();
  await useMockEngine(page, async (p) => {
    await p.getByTestId('auto-polish').check();
  });
  await holdSpace(page, 1500);
  await expect(page.getByTestId('transcript-result')).toBeVisible();
  await expect(page.getByTestId('toast').filter({ hasText: /AI polish skipped/ })).toBeVisible();
  await expect(page.getByTestId('transcript-result')).not.toContainText('AI polished');
  const stored = await page.request.get('/api/dictations').then((r) => r.json());
  expect(stored.total).toBe(1);
  expect(stored.items[0].polished).toBe(false);
  expect(stored.items[0].text).toMatch(/^This is a mock transcription/);
});

test('auto-polish stores the polished text when /api/polish succeeds', async ({ page }) => {
  await enablePolish(page);
  const polishCalls: Array<{ text: string; mode: string }> = [];
  await page.route('**/api/polish', (route) => {
    polishCalls.push(route.request().postDataJSON() as { text: string; mode: string });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: 'Auto polished.', mode: 'clean', model: 'fake-model' }),
    });
  });
  await page.reload();
  await useMockEngine(page, async (p) => {
    await p.getByTestId('auto-polish').check();
  });
  await holdSpace(page, 1500);
  await expect(page.getByTestId('result-text')).toHaveValue('Auto polished.');
  await expect(page.getByTestId('transcript-result')).toContainText('AI polished');
  expect(polishCalls[0]).toMatchObject({ mode: 'clean' });
  expect(polishCalls[0].text).toMatch(/^This is a mock transcription/);
  const stored = await page.request.get('/api/dictations').then((r) => r.json());
  expect(stored.items[0]).toMatchObject({ text: 'Auto polished.', polished: true });
});

test('deleting the open dictation from the list or with Clear all clears the editor', async ({ page }) => {
  for (const text of ['Alpha text.', 'Beta text.', 'Gamma text.']) {
    await page.request.post('/api/dictations', { data: { text, engine: 'mock', durationMs: 1000 } });
  }
  await page.reload();
  await expect(page.getByTestId('history-item')).toHaveCount(3);

  // Delete the open dictation from its own row.
  await openRow(page, 'Beta text.').click();
  await expect(page.getByTestId('result-text')).toHaveValue('Beta text.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('history-item').filter({ hasText: 'Beta text.' }).getByRole('button', { name: 'Delete dictation' }).click();
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
  await expect(page.getByTestId('history-item')).toHaveCount(2);

  // The editor's Delete treats a dictation that is already gone (another tab, curl) as deleted.
  await openRow(page, 'Alpha text.').click();
  await expect(page.getByTestId('result-text')).toHaveValue('Alpha text.');
  const stored = await page.request.get('/api/dictations').then((r) => r.json());
  const alpha = stored.items.find((d: { text: string }) => d.text === 'Alpha text.');
  await page.request.delete(`/api/dictations/${alpha.id}`);
  await page.getByTestId('delete-button').click();
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
  await expect(page.getByTestId('toast').filter({ hasText: /Could not delete/ })).toHaveCount(0);
  await expect(page.getByTestId('history-item')).toHaveCount(1);

  // Clear all with a dictation open.
  await openRow(page, 'Gamma text.').click();
  await expect(page.getByTestId('result-text')).toHaveValue('Gamma text.');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByTestId('clear-all').click();
  await expect(page.getByTestId('history-empty')).toBeVisible();
  await expect(page.getByTestId('transcript-empty')).toBeVisible();
});

test('history and stats recover after the server comes back', async ({ page }) => {
  await page.request.post('/api/dictations', { data: { text: 'Seeded.', engine: 'mock', durationMs: 1000 } });
  await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  await page.reload();
  await expect(page.getByTestId('server-status')).toContainText('Server offline');
  await expect(page.getByTestId('history')).toContainText('History is unavailable while the server is offline.');
  await expect(page.getByTestId('stat-count')).toHaveText('–');

  await page.unroute('**/api/**');
  await expect(page.getByTestId('server-status')).toContainText('Server connected');
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(page.getByTestId('stat-count')).toHaveText('1');
});

test('the settings tab fits the viewport and Reset asks before dropping the dictionary', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('settings')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByTestId('dictionary-add').click();
  await page.getByLabel('Heard as').fill('wisper');
  const reset = page.getByRole('button', { name: 'Reset to defaults' });
  page.once('dialog', (dialog) => dialog.dismiss());
  await reset.click();
  await expect(page.getByLabel('Heard as')).toHaveValue('wisper');
  page.once('dialog', (dialog) => dialog.accept());
  await reset.click();
  await expect(page.getByLabel('Heard as')).toHaveCount(0);
});
