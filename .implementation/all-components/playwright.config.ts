import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.APARECIUM_TEST_PORT ?? 4173);
const baseURL = `http://localhost:${port}`;

/**
 * Aparecium's browser test runs against the production build, served by
 * `vite preview`, because that is what a user actually gets.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    // Existing acceptance workflows exercise deterministic finite runs. Live
    // browser tests explicitly use a fresh storage state and the default mode.
    storageState: { cookies: [], origins: [{ origin: baseURL,
      localStorage: [{ name: 'aparecium.mode', value: 'timed' }] }] },
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
