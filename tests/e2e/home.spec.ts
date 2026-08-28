import { expect, test } from '@playwright/test';

test('home page states the problem and reports the seeded catalog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('search by symptom');

  const seeded = page.getByText('Catalog products seeded');
  await expect(seeded).toBeVisible();
  await expect(seeded.locator('xpath=following-sibling::dd[1]')).toHaveText('50');
});

test('has no obvious accessibility blockers on the landing page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
  await expect(page.locator('main#main')).toBeVisible();
});
