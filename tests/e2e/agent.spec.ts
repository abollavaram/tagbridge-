import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: email }).click();
  await page.waitForURL(/\/(account|admin)/);
}

test.describe('the agent endpoint', () => {
  test('describes its guardrails on GET', async ({ request }) => {
    const response = await request.get('/api/agent');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.guardrails).toContain('no_model_price');
    expect(body.guardrails).toContain('human_in_the_loop');
  });

  test('refuses an anonymous caller', async ({ request }) => {
    const response = await request.post('/api/agent', { data: { request: 'find a gateway' } });
    expect(response.status()).toBe(401);
  });

  test('rejects a malformed body rather than guessing', async ({ request }) => {
    const response = await request.post('/api/agent', { data: { nonsense: true } });
    expect([400, 401]).toContain(response.status());
  });

  test('answers a signed-in buyer and returns a trace', async ({ page, request }) => {
    await signIn(page, 'buyer@example.com');
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const response = await request.post('/api/agent', {
      data: { request: 'ControlLogix to SQL Server, 5000 tags. Quote it.' },
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(body.trace)).toBe(true);
    expect(body.trace.some((t: { tool: string }) => t.tool === 'resolveCompatibility')).toBe(true);
  });
});

test.describe('quote approval', () => {
  test.describe.configure({ mode: 'serial' });

  test('is refused to a buyer', async ({ page }) => {
    await signIn(page, 'buyer@example.com');
    await page.goto('/approvals');
    await expect(page).toHaveURL(/\/403/);
  });

  test('an approver reaches it', async ({ page }) => {
    await signIn(page, 'sales@example.com');
    await page.goto('/approvals');
    await expect(page.getByRole('heading', { name: 'Quote approval' })).toBeVisible();
  });

  test('an agent-drafted quote appears for a decision and can be approved', async ({
    page,
    request,
  }) => {
    await signIn(page, 'buyer@example.com');
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const drafted = await request.post('/api/agent', {
      data: { request: 'Siemens S7-1500 to InfluxDB, 800 tags. Please quote it.' },
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    });
    expect(drafted.status()).toBe(200);
    const body = await drafted.json();
    expect(body.trace.some((t: { tool: string; ok: boolean }) => t.tool === 'createQuote' && t.ok)).toBe(
      true,
    );

    await signIn(page, 'admin@example.com');
    await page.goto('/approvals');

    const table = page.getByRole('table', { name: 'Quotes awaiting approval' });
    await expect(table).toBeVisible();

    await table.getByRole('button', { name: 'Approve and send' }).first().click();
    await expect(page.getByRole('heading', { name: 'Recently decided' })).toBeVisible();
  });
});
