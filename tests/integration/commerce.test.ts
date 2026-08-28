import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

// Exercises the commerce modules against the same in-process Postgres the app
// itself resolves through getDatabase(), rather than a hand-built one.
delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { seed } = await import('@/lib/db/seed');
const { auditLog, orderItems, orders, priceTiers, productVariants } =
  await import('@/lib/db/schema');
const { priceCartLines } = await import('@/lib/commerce/cart');
const {
  placeOrder,
  OrderError,
  formatOrderNumber,
  nextOrderNumber,
  getOrderByNumber,
  markOrderPaid,
} = await import('@/lib/commerce/orders');
const { listProducts, catalogFacets, getProductBySlug, laddersForVariants } = await import(
  '@/lib/commerce/catalog'
);
const { resolveUnitPriceCents } = await import('@/lib/commerce/pricing');

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;

/** A cart is now just a list of lines; nothing is written to the database. */
function cartOf(lines: { variantId: string; qty: number }[]): { variantId: string; qty: number }[] {
  return lines;
}

async function variantBySku(sku: string) {
  const rows = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.sku, sku))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`no variant ${sku}`);
  return row;
}

beforeAll(async () => {
  db = await getDatabase();
  await seed(db);
}, 180_000);

describe('catalog queries', () => {
  it('pages the catalog and reports the true total', async () => {
    const page = await listProducts();
    expect(page.total).toBe(50);
    expect(page.items).toHaveLength(12);
    expect(page.pageCount).toBe(5);
  });

  it('filters by category', async () => {
    const page = await listProducts({ category: 'OPC Servers' });
    expect(page.total).toBe(8);
    for (const item of page.items) expect(item.category).toBe('OPC Servers');
  });

  it('filters by a protocol held in an array column', async () => {
    const page = await listProducts({ protocol: 'Modbus RTU' });
    expect(page.total).toBeGreaterThan(0);
    for (const item of page.items) expect(item.protocols).toContain('Modbus RTU');
  });

  it('filters by vendor compatibility', async () => {
    const page = await listProducts({ vendor: 'ControlLogix' });
    expect(page.total).toBeGreaterThan(0);
  });

  it('combines filters conjunctively', async () => {
    const broad = await listProducts({ protocol: 'OPC UA' });
    const narrow = await listProducts({ protocol: 'OPC UA', licenseType: 'subscription' });
    expect(narrow.total).toBeLessThan(broad.total);
  });

  it('reports the cheapest variant as the from-price', async () => {
    const page = await listProducts({ category: 'OPC Servers' });
    const item = page.items.find((p) => p.sku === 'TB-OPCUA-4100');
    expect(item?.fromPriceCents).toBe(189_000);
  });

  it('builds facets across every active product', async () => {
    const facets = await catalogFacets();
    expect(facets.categories).toHaveLength(7);
    expect(facets.categories.reduce((n, c) => n + c.count, 0)).toBe(50);
    expect(facets.protocols.some((p) => p.value === 'OPC UA')).toBe(true);
    expect(facets.vendors.some((v) => v.value === 'Allen-Bradley')).toBe(true);
    expect(facets.licenseTypes.reduce((n, c) => n + c.count, 0)).toBe(50);
  });

  it('loads a product with its variants and full price ladders', async () => {
    const product = await getProductBySlug('meridian-opc-ua-server-allen-bradley');
    expect(product).not.toBeNull();
    expect(product?.variants).toHaveLength(3);
    for (const variant of product?.variants ?? []) {
      expect(variant.tiers).toHaveLength(4);
      expect(variant.tiers[0]?.minQty).toBe(1);
    }
  });

  it('returns null for an unknown slug rather than throwing', async () => {
    expect(await getProductBySlug('no-such-product')).toBeNull();
  });
});

describe('cart pricing comes from the database', () => {
  it('applies the volume break that the quantity earns', async () => {
    const variant = await variantBySku('TB-OPCUA-4100-M');
    const cart = await priceCartLines(cartOf([{ variantId: variant.id, qty: 10 }]));

    const ladders = await laddersForVariants([variant.id]);
    const expected = resolveUnitPriceCents(ladders.get(variant.id) ?? [], 10);

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.unitPriceCents).toBe(expected);
    expect(cart.lines[0]?.unitPriceCents).toBeLessThan(variant.listPriceCents);
    expect(cart.subtotalCents).toBe(expected * 10);
  });

  it('re-reads the price after the ladder changes, because the cart stores no price', async () => {
    const variant = await variantBySku('TB-DIAG-9700-SGL');
    const lines = cartOf([{ variantId: variant.id, qty: 1 }]);
    const before = await priceCartLines(lines);

    await db
      .update(priceTiers)
      .set({ unitPriceCents: 1_234 })
      .where(eq(priceTiers.variantId, variant.id));

    const after = await priceCartLines(lines);
    expect(before.lines[0]?.unitPriceCents).not.toBe(1_234);
    expect(after.lines[0]?.unitPriceCents).toBe(1_234);
    expect(after.subtotalCents).toBe(1_234);
  });

  it('sums a mixed cart', async () => {
    const a = await variantBySku('TB-GW-5100-S');
    const b = await variantBySku('TB-MQTT-7100-M-S');
    const cart = await priceCartLines(
      cartOf([
        { variantId: a.id, qty: 5 },
        { variantId: b.id, qty: 2 },
      ]),
    );
    expect(cart.lines).toHaveLength(2);
    expect(cart.itemCount).toBe(7);
    const expected = cart.lines.reduce((n: number, l) => n + l.unitPriceCents * l.qty, 0);
    expect(cart.subtotalCents).toBe(expected);
  });

  it('reports an empty cart as empty rather than failing', async () => {
    const cart = await priceCartLines(cartOf([]));
    expect(cart.lines).toEqual([]);
    expect(cart.subtotalCents).toBe(0);
  });
});

describe('purchase order checkout', () => {
  it('creates an order with no payment taken', async () => {
    const variant = await variantBySku('TB-OPCUA-4200-L');
    const cart = cartOf([{ variantId: variant.id, qty: 2 }]);

    const order = await placeOrder({
      lines: cart,
      email: 'buyer@example.com',
      companyName: 'Northfield Processing',
      paymentMethod: 'purchase_order',
      poNumber: 'PO-99213',
    });

    expect(order.status).toBe('po_received');
    expect(order.number).toMatch(/^TB-\d{6}-\d{6}$/);
    expect(order.subtotalCents).toBe(variant.listPriceCents * 2);

    const found = await getOrderByNumber(order.number);
    expect(found?.order.poNumber).toBe('PO-99213');
    expect(found?.order.stripeSessionId).toBeNull();
    expect(found?.items).toHaveLength(1);
  });

  it('snapshots the product name and SKU so a later catalog edit cannot rewrite the order', async () => {
    const variant = await variantBySku('TB-HIST-6100-S');
    const cart = cartOf([{ variantId: variant.id, qty: 1 }]);
    const order = await placeOrder({
      lines: cart,
      email: 'buyer@example.com',
      paymentMethod: 'purchase_order',
      poNumber: 'PO-1',
    });

    const found = await getOrderByNumber(order.number);
    const item = found?.items[0];
    expect(item?.variantSkuSnapshot).toBe('TB-HIST-6100-S');
    expect(item?.productNameSnapshot).toContain('Streamline Connector for SQL Server');
    expect(item?.unitPriceCents).toBe(variant.listPriceCents);
    expect(item?.lineTotalCents).toBe(variant.listPriceCents);
  });

  it('prices the order from the ladder, not from anything the caller sent', async () => {
    const variant = await variantBySku('TB-GW-5200-M');
    const cart = cartOf([{ variantId: variant.id, qty: 25 }]);
    const ladders = await laddersForVariants([variant.id]);
    const expected = resolveUnitPriceCents(ladders.get(variant.id) ?? [], 25);

    const order = await placeOrder({
      lines: cart,
      email: 'buyer@example.com',
      paymentMethod: 'purchase_order',
      poNumber: 'PO-25',
    });
    expect(order.subtotalCents).toBe(expected * 25);
  });

  it('refuses an empty cart rather than creating an order with no lines', async () => {
    // Clearing the cart after a successful order is the checkout action's job,
    // not this function's — `tests/e2e/shop.spec.ts` covers that end to end.
    // What is guaranteed here is that an empty cart never becomes an order.
    await expect(
      placeOrder({
        lines: [],
        email: 'buyer@example.com',
        paymentMethod: 'purchase_order',
        poNumber: 'PO-EMPTY',
      }),
    ).rejects.toThrow(OrderError);
  });

  it('refuses a PO order with no PO number', async () => {
    const variant = await variantBySku('TB-DIAG-9600-SGL');
    const cart = cartOf([{ variantId: variant.id, qty: 1 }]);
    await expect(
      placeOrder({
        lines: cart,
        email: 'buyer@example.com',
        paymentMethod: 'purchase_order',
        poNumber: '   ',
      }),
    ).rejects.toThrow(/purchase order number is required/);
  });

  it('writes an audit row for the placement', async () => {
    const variant = await variantBySku('TB-HMI-8100-S');
    const cart = cartOf([{ variantId: variant.id, qty: 1 }]);
    const order = await placeOrder({
      lines: cart,
      email: 'buyer@example.com',
      paymentMethod: 'purchase_order',
      poNumber: 'PO-AUDIT',
    });
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource, `order:${order.id}`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('order.placed');
  });
});

describe('card checkout order', () => {
  it('starts as pending payment and becomes paid only when told so out of band', async () => {
    const variant = await variantBySku('TB-MQTT-7200-M');
    const cart = cartOf([{ variantId: variant.id, qty: 3 }]);
    const order = await placeOrder({
      lines: cart,
      email: 'buyer@example.com',
      paymentMethod: 'card',
    });
    expect(order.status).toBe('pending_payment');

    await markOrderPaid(order.id, 'cs_test_123');
    const found = await getOrderByNumber(order.number);
    expect(found?.order.status).toBe('paid');
    expect(found?.order.stripeSessionId).toBe('cs_test_123');
  });
});

describe('order numbers', () => {
  it('are unique across a large batch, by construction rather than by luck', async () => {
    const numbers = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) numbers.add(await nextOrderNumber());
    expect(numbers.size).toBe(2_000);
  });

  it('carry the year and month', () => {
    expect(formatOrderNumber(42, new Date(Date.UTC(2026, 2, 14)))).toBe('TB-202603-000042');
  });

  it('pads the counter so numbers sort lexically', () => {
    expect(formatOrderNumber(7)).toMatch(/-000007$/);
    expect(formatOrderNumber(1_234_567)).toMatch(/-1234567$/);
  });
});

describe('housekeeping', () => {
  it('drops a line whose variant is no longer in the catalogue', async () => {
    const variant = await variantBySku('TB-HMI-8700-STD');
    const cart = await priceCartLines(
      cartOf([
        { variantId: variant.id, qty: 1 },
        { variantId: '11111111-1111-4111-8111-111111111111', qty: 1 },
      ]),
    );
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.variant.sku).toBe('TB-HMI-8700-STD');
  });

  it('refuses to place an order containing an unknown variant', async () => {
    await expect(
      placeOrder({
        lines: [{ variantId: '11111111-1111-4111-8111-111111111111', qty: 1 }],
        email: 'buyer@example.com',
        paymentMethod: 'purchase_order',
        poNumber: 'PO-GHOST',
      }),
    ).rejects.toThrow(/unknown variant/);
  });

  it('leaves no order without items', async () => {
    const allOrders = await db.select().from(orders);
    for (const order of allOrders) {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      expect(items.length, order.number).toBeGreaterThan(0);
    }
  });
});
