/**
 * Playwright E2E configuration for the SharkCraft dashboard.
 *
 * Runs against a deterministic fixture project at
 * examples/dashboard-e2e-target/. The webServer starts the local read-only
 * dashboard via the CLI and waits for /api/health to return readOnly:true.
 *
 * Chromium-only by design — the dashboard is a plain ESM/React bundle and
 * cross-browser regressions are not the bottleneck. Add WebKit/Firefox when
 * a real Safari/FF user shows up.
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.SHRK_DASHBOARD_E2E_PORT ?? 4677);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results/playwright',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `bun run packages/cli/src/main.ts --cwd examples/dashboard-e2e-target dashboard --no-open --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
