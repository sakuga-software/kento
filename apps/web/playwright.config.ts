import { generateKeyPairSync, randomBytes } from 'node:crypto'

import { defineConfig, devices } from '@playwright/test'

import { E2E_WEBHOOK_SECRET } from './e2e/fake-github.ts'

// The screens in Chromium, against the real server, a real Postgres and a fake GitHub
// (e2e/fake-github.ts) for the sign-in.
//
//   E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres pnpm -F @sakuga-review/web e2e
//
// The server applies its migrations to that database at startup: give it a throwaway one.
const port = Number(process.env.E2E_PORT ?? 3488)
const githubPort = Number(process.env.E2E_GITHUB_PORT ?? 3499)
const databaseUrl = process.env.E2E_DATABASE_URL
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is not set. See apps/web/README.md, "Develop".')

// A key of a fake App, made for this run only.
const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

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
  webServer: [
    {
      command: 'node --import remix/node-tsx e2e/fake-github.ts',
      url: `http://127.0.0.1:${githubPort}/healthz`,
      reuseExistingServer: false,
      env: { FAKE_GITHUB_PORT: String(githubPort), KENTO_URL: `http://127.0.0.1:${port}` },
    },
    {
      command: 'node --import remix/node-tsx server.ts',
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: appKey,
        GITHUB_APP_CLIENT_ID: 'Iv-e2e',
        GITHUB_APP_CLIENT_SECRET: 'e2e-client-secret',
        KENTO_PUBLIC_URL: `http://127.0.0.1:${port}`,
        KENTO_SESSION_SECRET: 'e2e-session-secret-0123456789abcdef',
        // The master key of the keys of the providers (REV-11): random, for this run only.
        KENTO_SECRETS_KEY: randomBytes(32).toString('base64'),
        GITHUB_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
      },
    },
  ],
})
