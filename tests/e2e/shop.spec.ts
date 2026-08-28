import { expect, test, type Page } from '@playwright/test';

test('catalog lists products and narrows by facet', async ({ page }) => {
  await page.goto('/products');
  await expect(page.getByRole('heading', { level: 1, name: 'Catalog' })).toBeVisible();
  await expect(page.getByText('50 products')).toBeVisible();

  const cards = page.locator('main ul li article');
  await expect(cards).toHaveCount(12);

  await page.getByRole('link', { name: /^OPC Servers/ }).first().click();
  await expect(page).toHaveURL(/category=OPC\+Servers/);
  await expect(page.getByText('8 products matching your filters')).toBeVisible();

  await page.getByRole('link', { name: 'Clear all filters' }).click();
  await expect(page).toHaveURL(/\/products$/);
});

test('catalog paginates', async ({ page }) => {
  await page.goto('/products');
  await expect(page.getByText('Page 1 of 5')).toBeVisible();
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 5')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Previous' })).toBeVisible();
});

test('product page shows the price ladder and links its facets', async ({ page }) => {
  await page.goto('/products/meridian-opc-ua-server-allen-bradley');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Meridian OPC UA Server for Allen-Bradley',
  );
  await expect(page.getByText('TB-OPCUA-4100', { exact: true })).toBeVisible();

  const ladder = page.getByRole('table').first();
  await expect(ladder.getByRole('row')).toHaveCount(5); // header + four breaks
  await expect(ladder.getByRole('cell', { name: '1–4' })).toBeVisible();
  await expect(ladder.getByRole('cell', { name: '25+' })).toBeVisible();
  await expect(ladder.getByRole('cell', { name: '$1,890.00' })).toBeVisible();

  await expect(page.getByRole('link', { name: 'ControlLogix' })).toBeVisible();
});

async function addFirstVariant(page: Page, qty: number) {
  await page.goto('/products/meridian-opc-ua-server-allen-bradley');
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Add to cart' }) }).first();
  await form.getByLabel('Quantity').fill(String(qty));
  await form.getByRole('button', { name: 'Add to cart' }).click();
  await page.waitForURL(/\/cart/);
}

test('adding at a volume break charges the break price, not the list price', async ({ page }) => {
  await addFirstVariant(page, 10);

  // $1,890.00 list; the 10+ break is 82% of it. A single-line cart repeats the
  // line total as the subtotal, so each is asserted where it belongs.
  const row = page.getByRole('row').filter({ hasText: '500 tags' });
  await expect(row.getByText('$1,549.80')).toBeVisible();
  await expect(row.getByText('$15,498.00')).toBeVisible();
  const subtotal = page.getByRole('row').filter({ hasText: 'Subtotal' });
  await expect(subtotal.getByText('$15,498.00')).toBeVisible();
});

test('cart quantity can be changed and the price re-resolves', async ({ page }) => {
  await addFirstVariant(page, 1);
  await expect(page.getByText('$1,890.00').first()).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: '500 tags' });
  await row.getByRole('spinbutton').fill('25');
  await row.getByRole('button', { name: 'Update' }).click();
  await page.waitForURL(/\/cart/);

  // 25+ break is 75% of list.
  const updated = page.getByRole('row').filter({ hasText: '500 tags' });
  await expect(updated.getByText('$1,417.50')).toBeVisible();
  await expect(
    page.getByRole('row').filter({ hasText: 'Subtotal' }).getByText('$35,437.50'),
  ).toBeVisible();
});

test('two different products both stay in the cart', async ({ page }) => {
  // The reported bug: with the cart held in per-instance server memory, items
  // added across different instances each vanished from the other's view, so
  // only some of what a buyer added ever showed up.
  await addFirstVariant(page, 1);

  await page.goto('/products/streamline-connector-sql-server');
  const second = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Add to cart' }) })
    .first();
  await second.getByLabel('Quantity').fill('2');
  await second.getByRole('button', { name: 'Add to cart' }).click();
  await page.waitForURL(/\/cart/);

  await expect(
    page.getByRole('link', { name: 'Meridian OPC UA Server for Allen-Bradley' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Streamline Connector for SQL Server' }),
  ).toBeVisible();
  const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Remove' }) });
  await expect(rows).toHaveCount(2);
});

test('a third product joins the first two rather than replacing them', async ({ page }) => {
  await addFirstVariant(page, 1);

  for (const slug of ['crosslink-gateway-modbus-rtu-serial-bridge', 'probe-modbus-scanner']) {
    await page.goto(`/products/${slug}`);
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Add to cart' }) })
      .first();
    await form.getByRole('button', { name: 'Add to cart' }).click();
    await page.waitForURL(/\/cart/);
  }

  const rows = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Remove' }) });
  await expect(rows).toHaveCount(3);
});

test('an item can be removed, emptying the cart', async ({ page }) => {
  await addFirstVariant(page, 2);
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.waitForURL(/\/cart/);
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
});

test('the purchase order path creates an order with no payment', async ({ page }) => {
  await addFirstVariant(page, 5);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page).toHaveURL(/\/checkout/);

  await expect(page.getByRole('heading', { name: 'Purchase order' })).toBeVisible();
  await page.getByLabel('Email').first().fill('buyer@example.com');
  await page.getByLabel('Company').first().fill('Northfield Processing');
  await page.getByLabel('Purchase order number').fill('PO-E2E-4471');
  await page.getByRole('button', { name: 'Place order against PO' }).click();

  await page.waitForURL(/\/checkout\/confirmation\//);
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.getByText(/^TB-\d{6}-\d{6}$/)).toBeVisible();
  await expect(page.getByText('po_received')).toBeVisible();
  await expect(page.getByText('PO-E2E-4471')).toBeVisible();
  await expect(page.getByText('Nothing has been charged.')).toBeVisible();
  // 5+ break is 90% of the $1,890.00 list price.
  await expect(
    page.getByRole('row').filter({ hasText: 'Subtotal' }).getByText('$8,505.00'),
  ).toBeVisible();
});

test('the cart is emptied once the order is placed', async ({ page }) => {
  await addFirstVariant(page, 1);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByLabel('Email').first().fill('buyer@example.com');
  await page.getByLabel('Purchase order number').fill('PO-E2E-ONCE');
  await page.getByRole('button', { name: 'Place order against PO' }).click();
  await page.waitForURL(/\/checkout\/confirmation\//);

  await page.goto('/cart');
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
});

test('card checkout says plainly that it is not configured', async ({ page }) => {
  await addFirstVariant(page, 1);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Pay by card' })).toBeVisible();
  await expect(page.getByText('Card payment is not configured')).toBeVisible();
});

test('checkout with an empty cart returns to the cart', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page).toHaveURL(/\/cart/);
});
