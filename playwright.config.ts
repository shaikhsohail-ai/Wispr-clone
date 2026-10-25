import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT || 8790);
const DATA_DIR = process.env.E2E_DATA_DIR || join(tmpdir(), `wispr-clone-e2e-${process.pid}`);

/**
 * End-to-end tests drive the built web app served by the real server, with the mock
 * transcription engine enabled and Chromium feeding a synthetic microphone.
 * Run `npm run test:e2e` (which builds the web app first).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx server/index.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      WISPR_ENABLE_MOCK_ENGINE: '1',
      WISPR_DATA_DIR: DATA_DIR,
      WISPR_STATIC_DIR: 'dist',
    },
  },
});
