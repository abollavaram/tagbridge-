import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Builds the database snapshot, builds the app, then serves the
        // production build. The e2e run needs no provisioned database.
        command: `pnpm db:setup && pnpm build && pnpm start --port ${PORT}`,
        url: `http://127.0.0.1:${PORT}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e-only-secret-not-used-anywhere-else',
          AUTH_DEV_LOGIN: 'true',
          LOG_LEVEL: 'warn',
          // The reconciliation endpoint refuses to run unauthenticated. Giving
          // the e2e server a real secret exercises the same check production
          // uses, rather than a development escape hatch.
          CRON_SECRET: 'e2e-cron-secret',
          // Pinned explicitly rather than left to derive from AUTH_SECRET.
          // The webhook tests sign requests themselves, so they need the exact
          // secret the server verifies with — and CI sets AUTH_SECRET to a
          // per-run value, which silently made every signed request invalid.
          // This also exercises the configured-secret path production uses.
          STRIPE_WEBHOOK_SECRET: 'whsec_e2e_only_not_a_real_secret',
        },
      },
});
