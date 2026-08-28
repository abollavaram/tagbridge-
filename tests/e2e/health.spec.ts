import { expect, test } from '@playwright/test';

test('health endpoint reports the database as reachable', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    status: string;
    checks: { database: { ok: boolean } };
  };
  expect(body.status).toBe('ok');
  expect(body.checks.database.ok).toBe(true);
});
