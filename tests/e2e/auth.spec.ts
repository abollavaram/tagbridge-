import { expect, test } from '@playwright/test';

async function signInAs(page: import('@playwright/test').Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: email }).click();
  await page.waitForURL(/\/(account|admin)/);
}

test('a protected route redirects an anonymous visitor to sign in', async ({ page }) => {
  await page.goto('/account');
  await expect(page).toHaveURL(/\/signin\?callbackUrl=%2Faccount/);
});

test('an admin route redirects an anonymous visitor to sign in', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/signin\?callbackUrl=%2Fadmin/);
});

test('a buyer can sign in and sees their own role', async ({ page }) => {
  await signInAs(page, 'buyer@example.com');
  await expect(page).toHaveURL(/\/account/);
  await expect(page.getByText('buyer@example.com')).toBeVisible();
  const role = page.getByText('Role', { exact: true });
  await expect(role.locator('xpath=following-sibling::dd[1]')).toHaveText('buyer');
});

test('a buyer is refused the admin area', async ({ page }) => {
  await signInAs(page, 'buyer@example.com');
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/403/);
  await expect(page.getByRole('heading', { name: 'Not permitted' })).toBeVisible();
});

test('an admin reaches the admin area', async ({ page }) => {
  await signInAs(page, 'admin@example.com');
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByRole('heading', { name: 'Administration' })).toBeVisible();
});

test('sign out returns the visitor to an anonymous session', async ({ page }) => {
  await signInAs(page, 'buyer@example.com');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('/');
  await page.goto('/account');
  await expect(page).toHaveURL(/\/signin/);
});

test('the account page shows a buyer their own quotes and orders', async ({ page }) => {
  await signInAs(page, 'buyer@example.com');
  await expect(page.getByRole('heading', { name: 'Your quotes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your orders' })).toBeVisible();
  // Whatever the state, it says something real rather than promising a later phase.
  await expect(page.getByText(/appear here from phase/i)).toHaveCount(0);
});

test('an order a buyer places appears on their account', async ({ page }) => {
  await signInAs(page, 'buyer@example.com');

  await page.goto('/products/meridian-opc-ua-server-allen-bradley');
  const form = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Add to cart' }) })
    .first();
  await form.getByLabel('Quantity').fill('2');
  await form.getByRole('button', { name: 'Add to cart' }).click();
  await page.waitForURL(/\/cart/);

  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByLabel('Email').first().fill('buyer@example.com');
  await page.getByLabel('Company').first().fill('Northfield Processing');
  await page.getByLabel('Purchase order number').fill('PO-ACCOUNT-1');
  await page.getByRole('button', { name: 'Place order against PO' }).click();
  await page.waitForURL(/\/checkout\/confirmation\//);

  // The order is the buyer's own, so it belongs on their account page.
  await page.goto('/account');
  const orders = page.getByRole('table', { name: 'Your orders' });
  await expect(orders).toBeVisible();
  await expect(orders.getByText('PO-ACCOUNT-1')).toBeVisible();
});
