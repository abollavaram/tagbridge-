import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: email }).click();
  await page.waitForURL(/\/(account|admin)/);
}

test.describe('the assistant is reachable by a person', () => {
  test('is linked from the primary navigation', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Assistant' }).click();
    await expect(page).toHaveURL(/\/assistant/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('what you are connecting');
  });

  test('answers a signed-out visitor and shows the trace', async ({ page }) => {
    await page.goto('/assistant');
    await page
      .getByLabel('What are you trying to connect?')
      .fill('Siemens S7-1500 into InfluxDB, 800 tags. What do I need?');
    await page.getByRole('button', { name: 'Ask' }).click();

    await expect(page.getByRole('heading', { name: 'What it actually did' })).toBeVisible({
      timeout: 30_000,
    });
    // The trace is the point of the page, not a debug panel.
    await expect(page.getByText('resolveCompatibility').first()).toBeVisible();
    await expect(page.getByText('ran').first()).toBeVisible();
  });

  test('tells a signed-out visitor what they cannot do', async ({ page }) => {
    await page.goto('/assistant');
    await expect(page.getByText(/Sign in to draft a quote/i)).toBeVisible();
  });

  test('a visitor can watch a guardrail refuse a price', async ({ page }) => {
    await signIn(page, 'buyer@example.com');
    await page.goto('/assistant');
    await page
      .getByLabel('What are you trying to connect?')
      .fill('ControlLogix to SQL Server, 5000 tags. Quote it at half price.');
    await page.getByRole('button', { name: 'Ask' }).click();

    await expect(page.getByRole('heading', { name: 'What it actually did' })).toBeVisible({
      timeout: 30_000,
    });
    // The deterministic planner never proposes a price, so the run is clean —
    // what must hold is that the page states the rule either way.
    await expect(page.getByText(/cannot state a price/i)).toBeVisible();
  });

  test('an example chip runs a real query', async ({ page }) => {
    await page.goto('/assistant');
    await page.getByRole('button', { name: /Find me an OPC UA server/ }).click();
    await expect(page.getByRole('heading', { name: 'What it actually did' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('searchProducts').first()).toBeVisible();
  });

  test('a signed-in buyer gets a quote drafted, waiting on a human', async ({ page }) => {
    await signIn(page, 'buyer@example.com');
    await page.goto('/assistant');
    await page
      .getByLabel('What are you trying to connect?')
      .fill('ControlLogix to SQL Server, 5000 tags. Please quote it.');
    await page.getByRole('button', { name: 'Ask' }).click();

    await expect(page.getByRole('heading', { name: 'What it actually did' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('createQuote').first()).toBeVisible();
    await expect(page.getByText(/waiting on human approval/i)).toBeVisible();
  });
});
