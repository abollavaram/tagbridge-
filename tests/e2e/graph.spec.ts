import { expect, test } from '@playwright/test';

test('the graph page renders the real graph with its counts', async ({ page }) => {
  await page.goto('/graph');
  await expect(page.getByRole('heading', { level: 1, name: 'Knowledge graph' })).toBeVisible();
  await expect(page.getByText(/\d+ nodes and \d+ edges/)).toBeVisible();
  await expect(page.getByRole('img', { name: /Nodes connected to/ })).toBeVisible();
});

test('a node can be navigated into', async ({ page }) => {
  await page.goto('/graph?kind=vendor&key=allen-bradley');
  await expect(page.getByRole('heading', { level: 2, name: 'Allen-Bradley' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Nodes connected to Allen-Bradley' })).toBeVisible();

  await page.getByRole('link', { name: /edges, as a list/ }).count();
  const list = page.getByRole('group');
  await expect(list).toBeVisible();
});

test('switching node kind changes the entry points', async ({ page }) => {
  await page.goto('/graph?kind=protocol');
  await page.getByRole('link', { name: 'vendor', exact: true }).click();
  await expect(page).toHaveURL(/kind=vendor/);
  // The sidebar heading names the kind currently being listed.
  await expect(page.getByRole('heading', { level: 2, name: 'vendors' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Nodes connected to/ })).toBeVisible();
});

test('the edge list names the relation between two nodes', async ({ page }) => {
  await page.goto('/graph?kind=protocol&key=modbus-tcp');
  await page.getByRole('group').click();
  await expect(page.getByText(/speaks|tested against|also called/).first()).toBeVisible();
});
