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
  await expect(error).toContainText(/too short|never started/i);
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
