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
