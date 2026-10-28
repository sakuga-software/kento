import { defineConfig, devices } from '@playwright/test'

// The screens in Chromium, against the real server and a real Postgres.
//
//   E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm -F @sakuga-review/web e2e
//
// The server applies its migrations to that database at startup: give it a throwaway one.
const port = Number(process.env.E2E_PORT ?? 3488)
const databaseUrl = process.env.E2E_DATABASE_URL
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is not set. See apps/web/README.md, « Develop ».')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
  webServer: {
    command: 'node --import remix/node-tsx server.ts',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
    },
  },
})
