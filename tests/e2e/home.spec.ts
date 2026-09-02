import { expect, test } from '@playwright/test';

test('home page states the problem and reports the seeded catalog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'not the part number you do not know yet',
  );

  const seeded = page.getByText('Products in catalog');
  await expect(seeded).toBeVisible();
  await expect(seeded.locator('xpath=following-sibling::dd[1]')).toHaveText('50');
});

test('the hero search actually searches', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Describe what you are connecting').fill('Rockwell');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/\/search\?q=Rockwell/);
  await expect(page.getByRole('list', { name: 'Search results' })).toBeVisible();
});

test('an example chip runs a real search', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'historian drops tags overnight' }).click();
  await expect(page).toHaveURL(/\/search/);
  await expect(page.getByRole('list', { name: 'Search results' })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: /6 of 6 phases shipped/ })).toBeVisible();
  await expect(page.getByText(/Phase 2 adds/)).toHaveCount(0);
});

test('home page publishes the measured numbers with what they measure', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Search precision@3')).toBeVisible();
  await expect(page.getByText('0.89')).toBeVisible();
  await expect(page.getByText(/over 100 queries/)).toBeVisible();
  // The missed target is on the page, not buried.
  await expect(page.getByText(/under the 15% the plan asked for/)).toBeVisible();
});

test('home page links to each piece of shipped work', async ({ page }) => {
  await page.goto('/');
  const built = page.getByLabel(/phases shipped/i);
  for (const name of ['The assistant', 'Hybrid search', 'Knowledge graph']) {
    await expect(built.getByRole('link', { name: new RegExp(name) })).toBeVisible();
  }
});
