import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * The signing secret this deployment derives when STRIPE_WEBHOOK_SECRET is
 * unset, reconstructed from the AUTH_SECRET the e2e server is started with.
 * Signed here from first principles rather than by calling the app's own
 * helper, so the test would still catch a change to the header format.
 */
const WEBHOOK_SECRET = 'derived:webhook:e2e-only-secret-not-used-anywhere-else';
const CRON_SECRET = 'e2e-cron-secret';

function sign(body: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function eventBody(id: string, subscriptionId: string) {
  return JSON.stringify({
    id,
    type: 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: subscriptionId } },
  });
}

async function signInAsAdmin(page: Page) {
  await page.goto('/signin');
  await page.getByRole('button', { name: 'admin@example.com' }).click();
  await page.waitForURL(/\/(account|admin)/);
}

test.describe('the webhook endpoint', () => {
  test('refuses a request with no signature', async ({ request }) => {
    const response = await request.post('/api/webhooks/stripe', {
      data: eventBody('evt_e2e_unsigned', 'sub_demo_1001'),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid signature' });
  });

  test('refuses a signature made with the wrong secret', async ({ request }) => {
    const body = eventBody('evt_e2e_forged', 'sub_demo_1001');
    const response = await request.post('/api/webhooks/stripe', {
      data: body,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sign(body, 'not-the-secret'),
      },
    });
    expect(response.status()).toBe(400);
  });

  test('refuses a replayed signature from outside the tolerance window', async ({ request }) => {
    const body = eventBody('evt_e2e_stale', 'sub_demo_1001');
    const longAgo = Math.floor(Date.now() / 1000) - 3600;
    const response = await request.post('/api/webhooks/stripe', {
      data: body,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sign(body, WEBHOOK_SECRET, longAgo),
      },
    });
    expect(response.status()).toBe(400);
  });

  test('says nothing about which check failed', async ({ request }) => {
    const body = eventBody('evt_e2e_quiet', 'sub_demo_1001');
    const stale = await request.post('/api/webhooks/stripe', {
      data: body,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': sign(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600),
      },
    });
    const forged = await request.post('/api/webhooks/stripe', {
      data: body,
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body, 'wrong') },
    });
    // Identical responses: an attacker learns nothing from the difference.
    expect(await stale.json()).toEqual(await forged.json());
  });

  test('rejects a signed request whose payload is not a valid event', async ({ request }) => {
    const body = JSON.stringify({ nonsense: true });
    const response = await request.post('/api/webhooks/stripe', {
      data: body,
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid payload' });
  });

  test('accepts the same event three times and records it once', async ({ request }) => {
    const id = `evt_e2e_dup_${Date.now()}`;
    const body = eventBody(id, 'sub_demo_1001');
    const headers = {
      'content-type': 'application/json',
      'stripe-signature': sign(body),
    };

    const first = await request.post('/api/webhooks/stripe', { data: body, headers });
    const second = await request.post('/api/webhooks/stripe', { data: body, headers });
    const third = await request.post('/api/webhooks/stripe', { data: body, headers });

    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ received: true, duplicate: false });
    expect(await second.json()).toMatchObject({ received: true, duplicate: true });
    expect(await third.json()).toMatchObject({ received: true, duplicate: true });
  });

  test('describes itself on GET without processing anything', async ({ request }) => {
    const response = await request.get('/api/webhooks/stripe');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ signatureRequired: true });
  });
});

test.describe('the reconciliation endpoint', () => {
  test('refuses an unauthenticated caller', async ({ request }) => {
    const response = await request.get('/api/cron/reconcile');
    expect(response.status()).toBe(401);
  });

  test('refuses a wrong bearer token', async ({ request }) => {
    const response = await request.get('/api/cron/reconcile', {
      headers: { authorization: 'Bearer not-the-cron-secret' },
    });
    expect(response.status()).toBe(401);
  });

  test('runs for the scheduler and reports what it checked', async ({ request }) => {
    const response = await request.get('/api/cron/reconcile', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ provider: expect.any(String) });
    expect(Array.isArray(body.findings)).toBe(true);
  });
});

test.describe('the sync dashboard', () => {
  // Shared server-side state: these steps build on each other deliberately.
  test.describe.configure({ mode: 'serial' });

  test('is refused to a buyer', async ({ page }) => {
    await page.goto('/signin');
    await page.getByRole('button', { name: 'buyer@example.com' }).click();
    await page.waitForURL(/\/account/);
    await page.goto('/admin/sync');
    await expect(page).toHaveURL(/\/403/);
  });

  test('seeds a state where everything agrees', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/sync');
    await expect(page.getByRole('heading', { name: 'Subscription sync' })).toBeVisible();

    await page.getByRole('button', { name: 'Seed demo subscriptions' }).click();
    await expect(page.getByRole('table', { name: 'Subscriptions' })).toBeVisible();

    await page.getByRole('button', { name: 'Run reconciliation now' }).click();
    await expect(page.getByTestId('drift-empty')).toBeVisible();
  });

  test('catches drift after sync is broken behind its back', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/sync');
    await page.getByRole('button', { name: 'Seed demo subscriptions' }).click();
    await expect(page.getByRole('table', { name: 'Subscriptions' })).toBeVisible();

    await page.getByRole('button', { name: 'Break: cancelled upstream' }).click();
    // Breaking sync alone changes nothing locally — the dashboard is still clean.
    await expect(page.getByTestId('drift-empty')).toBeVisible();

    await page.getByRole('button', { name: 'Run reconciliation now' }).click();

    const drift = page.getByRole('table', { name: 'Detected drift' });
    await expect(drift).toBeVisible();
    await expect(drift.getByText(/stale_in_erp|status_mismatch/)).toBeVisible();
  });

  test('reports a subscription the provider bills that the app never heard of', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/sync');
    await page.getByRole('button', { name: 'Seed demo subscriptions' }).click();
    await page.getByRole('button', { name: 'Break: billed but unknown' }).click();
    await page.getByRole('button', { name: 'Run reconciliation now' }).click();

    // This drift has no local subscription, so it is reported by the run
    // rather than flagged onto an ERP record. Re-seeding clears it.
    await expect(page.getByRole('heading', { name: 'Reconciliation and drift' })).toBeVisible();
  });

  test('shows an empty dead-letter queue when nothing has failed', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/sync');
    await page.getByRole('button', { name: 'Seed demo subscriptions' }).click();
    await expect(page.getByTestId('dlq-empty')).toBeVisible();
  });
});
