import { expect, test, type Page } from '@playwright/test';

/** The results list, scoped so the header navigation's own list items cannot match. */
function results(page: Page) {
  return page.getByRole('list', { name: 'Search results' }).getByRole('listitem');
}

test('the search page offers examples before anything is typed', async ({ page }) => {
  await page.goto('/search');
  await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'get tag data from a ControlLogix into SQL Server' }),
  ).toBeVisible();
});

test('a part number returns that product first', async ({ page }) => {
  await page.goto('/search');
  await page.getByLabel('Search the catalogue').fill('TB-OPCUA-4100');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.waitForURL(/\/search\?q=/);

  await expect(results(page).first()).toContainText('TB-OPCUA-4100');
  await expect(page.getByText('specific-product')).toBeVisible();
});

test('a Rockwell query finds Allen-Bradley products and says why', async ({ page }) => {
  await page.goto('/search?q=Rockwell+PLC+connector');
  await expect(results(page).first()).toContainText('Allen-Bradley');
  await expect(page.getByText('Expanded to')).toBeVisible();
});

test('a described problem is read as a browse intent', async ({ page }) => {
  await page.goto('/search?q=we+lose+data+when+the+network+drops+overnight');
  await expect(page.getByText('browse', { exact: true })).toBeVisible();
  await expect(results(page).first()).toBeVisible();
});

test('a compatibility question is recognised as one', async ({ page }) => {
  await page.goto('/search?q=does+this+work+with+Modbus+RTU+over+serial');
  await expect(page.getByText('compatibility-question')).toBeVisible();
  await expect(results(page).first()).toContainText('TB-GW-5200');
});

test('a result links through to its product page', async ({ page }) => {
  await page.goto('/search?q=TB-GW-5200');
  await results(page).first().getByRole('link').first().click();
  await expect(page).toHaveURL(/\/products\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the search API answers with hits and an intent', async ({ request }) => {
  const response = await request.get('/api/search?q=Rockwell%20PLC%20connector&limit=5');
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    hits: { sku: string; reasons: string[] }[];
    intent: { intent: string };
    expandedTerms: string[];
  };
  expect(body.hits.length).toBeGreaterThan(0);
  expect(body.hits.length).toBeLessThanOrEqual(5);
  expect(body.expandedTerms).toContain('allen-bradley');
  expect(body.hits[0]?.reasons.length).toBeGreaterThan(0);
});

test('the search API rejects a malformed request rather than guessing', async ({ request }) => {
  expect((await request.get('/api/search?q=')).status()).toBe(400);
  expect((await request.get('/api/search?q=modbus&limit=999')).status()).toBe(400);
  expect((await request.get('/api/search?q=modbus&mode=telepathy')).status()).toBe(400);
});
