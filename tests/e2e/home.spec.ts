import { expect, test } from '@playwright/test';

test('home page states the problem and reports the seeded catalog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('search by symptom');

  const seeded = page.getByText('Products seeded');
  await expect(seeded).toBeVisible();
  await expect(seeded.locator('xpath=following-sibling::dd[1]')).toHaveText('50');
});

test('has no obvious accessibility blockers on the landing page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
  await expect(page.locator('main#main')).toBeVisible();
});

test('home page reports the real build state, not a stale phase number', async ({ page }) => {
  await page.goto('/');
  // The bug this replaces: a hardcoded "Phase 2" that outlived three phases.
  await expect(page.getByText('Phases shipped')).toBeVisible();
  await expect(page.getByText('6/6')).toBeVisible();
  await expect(page.getByText(/Phase 2 adds/)).toHaveCount(0);
});

test('home page links to every shipped phase', async ({ page }) => {
  await page.goto('/');
  // Scoped to the status section: the header nav also has a "Search" link.
  const status = page.getByLabel('Build status');
  for (const name of ['Search', 'Catalog and cart', 'Subscription sync']) {
    await expect(status.getByRole('link', { name, exact: true })).toBeVisible();
  }
});
