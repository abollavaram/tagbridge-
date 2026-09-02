import { expect, test, type Page } from '@playwright/test';

/**
 * The three security defects, reproduced over real HTTP against a production
 * build — the same way they were originally found. Each test performs the
 * attack and asserts it now fails.
 */

async function signIn(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: email }).click();
  await page.waitForURL(/\/(account|admin)/);
}

async function cookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Places a PO order and returns its number and the confirmation URL. */
async function placeOrder(page: Page, poNumber: string) {
  await page.goto('/products/meridian-opc-ua-server-allen-bradley');
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Add to cart' }) })
    .first();
  await form.getByLabel('Quantity').fill('2');
  await form.getByRole('button', { name: 'Add to cart' }).click();
  await page.waitForURL(/\/cart/);

  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByLabel('Email').first().fill('victim@example.com');
  await page.getByLabel('Company').first().fill('Northfield Processing');
  await page.getByLabel('Purchase order number').fill(poNumber);
  await page.getByRole('button', { name: 'Place order against PO' }).click();
  await page.waitForURL(/\/checkout\/confirmation\//);

  const url = new URL(page.url());
  const number = url.pathname.split('/').pop()!;
  return { number, url: page.url(), token: url.searchParams.get('t')! };
}

test.describe('F-01 — an order number is not a credential', () => {
  test('a stranger with the order number alone gets nothing', async ({ page, browser }) => {
    const { number, token } = await placeOrder(page, 'PO-VICTIM-1');
    expect(token).toBeTruthy();

    // A browser that has never visited the site, exactly as in the original
    // proof of concept.
    const attacker = await browser.newContext();
    const attackerPage = await attacker.newPage();
    const response = await attackerPage.goto(`/checkout/confirmation/${number}`);

    expect(response?.status()).toBe(404);
    await expect(attackerPage.getByText('PO-VICTIM-1')).toHaveCount(0);
    await attacker.close();
  });

  test('a guessed neighbouring order number gets nothing either', async ({ page, browser }) => {
    const { number } = await placeOrder(page, 'PO-VICTIM-2');
    // Numbers come from a sequence, so the neighbour is trivially derivable.
    const parts = number.split('-');
    const neighbour = `${parts[0]}-${parts[1]}-${String(Number(parts[2]) - 1).padStart(6, '0')}`;

    const attacker = await browser.newContext();
    const attackerPage = await attacker.newPage();
    const response = await attackerPage.goto(`/checkout/confirmation/${neighbour}`);
    expect(response?.status()).toBe(404);
    await attacker.close();
  });

  test('the buyer’s own confirmation link still works', async ({ page }) => {
    const { url } = await placeOrder(page, 'PO-MINE-1');
    const attacker = await page.goto(url);
    expect(attacker?.status()).toBe(200);
    await expect(page.getByText('PO-MINE-1')).toBeVisible();
  });

  test('a wrong token is refused', async ({ page, browser }) => {
    const { number } = await placeOrder(page, 'PO-VICTIM-3');
    const attacker = await browser.newContext();
    const attackerPage = await attacker.newPage();
    const response = await attackerPage.goto(
      `/checkout/confirmation/${number}?t=00000000-0000-4000-8000-000000000000`,
    );
    expect(response?.status()).toBe(404);
    await attacker.close();
  });

  test('the signed-in owner reaches it from their account with no token', async ({ page }) => {
    await signIn(page, 'buyer@example.com');
    const { number } = await placeOrder(page, 'PO-OWNER-1');

    const response = await page.goto(`/checkout/confirmation/${number}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByText('PO-OWNER-1')).toBeVisible();
  });
});

test.describe('F-02 — a checkout session belongs to its owner', () => {
  test('another signed-in buyer cannot read, rewrite or cancel it', async ({ page, browser }) => {
    // Victim creates a session.
    await signIn(page, 'admin@example.com');
    const victimCookie = await cookieHeader(page);
    const search = await (await page.request.get('/api/ucp/v1/catalog/search?query=OPC UA')).json();
    const variantId: string = search.products[0].offers[0].variant_id;

    const created = await page.request.post('/api/checkout_sessions', {
      data: { line_items: [{ item: { id: variantId }, quantity: 2 }], currency: 'USD' },
      headers: { cookie: victimCookie, 'content-type': 'application/json' },
    });
    expect(created.status()).toBe(201);
    const session = await created.json();
    const originalTotal = session.totals.find((t: { type: string }) => t.type === 'total').amount;

    // A different signed-in user, in their own browser context.
    const attackerContext = await browser.newContext();
    const attackerPage = await attackerContext.newPage();
    await signIn(attackerPage, 'buyer@example.com');
    const attackerCookie = await cookieHeader(attackerPage);
    const headers = { cookie: attackerCookie, 'content-type': 'application/json' };

    const read = await attackerPage.request.get(`/api/checkout_sessions/${session.id}`, {
      headers,
    });
    expect(read.status()).toBe(404);

    const rewrite = await attackerPage.request.post(`/api/checkout_sessions/${session.id}`, {
      data: { line_items: [{ item: { id: variantId }, quantity: 500 }] },
      headers,
    });
    expect(rewrite.status()).toBe(404);

    const cancel = await attackerPage.request.post(
      `/api/checkout_sessions/${session.id}/cancel`,
      { headers },
    );
    expect(cancel.status()).toBe(404);

    await attackerContext.close();

    // The victim's session is untouched.
    const after = await page.request.get(`/api/checkout_sessions/${session.id}`, {
      headers: { cookie: victimCookie },
    });
    expect(after.status()).toBe(200);
    const afterBody = await after.json();
    expect(afterBody.totals.find((t: { type: string }) => t.type === 'total').amount).toBe(
      originalTotal,
    );
    expect(afterBody.status).not.toBe('canceled');
  });
});

test.describe('F-05 — cancel obeys the state machine', () => {
  test('a second cancel is refused with 409', async ({ page }) => {
    await signIn(page, 'buyer@example.com');
    const cookie = await cookieHeader(page);
    const headers = { cookie, 'content-type': 'application/json' };

    const search = await (await page.request.get('/api/ucp/v1/catalog/search?query=OPC UA')).json();
    const variantId: string = search.products[0].offers[0].variant_id;

    const created = await page.request.post('/api/checkout_sessions', {
      data: { line_items: [{ item: { id: variantId }, quantity: 1 }], currency: 'USD' },
      headers,
    });
    const session = await created.json();

    const first = await page.request.post(`/api/checkout_sessions/${session.id}/cancel`, {
      headers,
    });
    expect(first.status()).toBe(200);

    // Used to return 200 "canceled" again, on an already-terminal quote.
    const second = await page.request.post(`/api/checkout_sessions/${session.id}/cancel`, {
      headers,
    });
    expect(second.status()).toBe(409);
  });
});
