import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tagbridge-commerce-'));
process.env.PGLITE_DATA_DIR = DATA_DIR;
delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { seed } = await import('@/lib/db/seed');
const { auditLog, cartItems, carts, orderItems, orders, priceTiers, productVariants } =
  await import('@/lib/db/schema');
const { readCartById, clearCart } = await import('@/lib/commerce/cart');
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

async function newCart(lines: { variantId: string; qty: number }[]): Promise<string> {
  const inserted = await db
    .insert(carts)
    .values({ anonymousId: globalThis.crypto.randomUUID() })
    .returning();
  const cartId = inserted[0]?.id;
  if (!cartId) throw new Error('no cart');
  for (const line of lines) {
    await db.insert(cartItems).values({ cartId, variantId: line.variantId, qty: line.qty });
  }
  return cartId;
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

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

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
    const cartId = await newCart([{ variantId: variant.id, qty: 10 }]);
    const cart = await readCartById(cartId);

    const ladders = await laddersForVariants([variant.id]);
    const expected = resolveUnitPriceCents(ladders.get(variant.id) ?? [], 10);

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.unitPriceCents).toBe(expected);
    expect(cart.lines[0]?.unitPriceCents).toBeLessThan(variant.listPriceCents);
    expect(cart.subtotalCents).toBe(expected * 10);
  });

  it('re-reads the price after the ladder changes, because the cart stores no price', async () => {
    const variant = await variantBySku('TB-DIAG-9700-SGL');
    const cartId = await newCart([{ variantId: variant.id, qty: 1 }]);
    const before = await readCartById(cartId);

    await db
      .update(priceTiers)
      .set({ unitPriceCents: 1_234 })
      .where(eq(priceTiers.variantId, variant.id));

    const after = await readCartById(cartId);
    expect(before.lines[0]?.unitPriceCents).not.toBe(1_234);
    expect(after.lines[0]?.unitPriceCents).toBe(1_234);
    expect(after.subtotalCents).toBe(1_234);
  });

  it('sums a mixed cart', async () => {
    const a = await variantBySku('TB-GW-5100-S');
    const b = await variantBySku('TB-MQTT-7100-M-S');
    const cartId = await newCart([
      { variantId: a.id, qty: 5 },
      { variantId: b.id, qty: 2 },
    ]);
    const cart = await readCartById(cartId);
    expect(cart.lines).toHaveLength(2);
    expect(cart.itemCount).toBe(7);
    const expected = cart.lines.reduce((n, l) => n + l.unitPriceCents * l.qty, 0);
    expect(cart.subtotalCents).toBe(expected);
  });

  it('reports an empty cart as empty rather than failing', async () => {
    const cartId = await newCart([]);
    const cart = await readCartById(cartId);
    expect(cart.lines).toEqual([]);
    expect(cart.subtotalCents).toBe(0);
  });
});

describe('purchase order checkout', () => {
  it('creates an order with no payment taken', async () => {
    const variant = await variantBySku('TB-OPCUA-4200-L');
    const cartId = await newCart([{ variantId: variant.id, qty: 2 }]);

    const order = await placeOrder({
      cartId,
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
    const cartId = await newCart([{ variantId: variant.id, qty: 1 }]);
    const order = await placeOrder({
      cartId,
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
    const cartId = await newCart([{ variantId: variant.id, qty: 25 }]);
    const ladders = await laddersForVariants([variant.id]);
    const expected = resolveUnitPriceCents(ladders.get(variant.id) ?? [], 25);

    const order = await placeOrder({
      cartId,
      email: 'buyer@example.com',
      paymentMethod: 'purchase_order',
      poNumber: 'PO-25',
    });
    expect(order.subtotalCents).toBe(expected * 25);
  });

  it('empties the cart so the order cannot be placed twice', async () => {
    const variant = await variantBySku('TB-RED-9100-STD');
    const cartId = await newCart([{ variantId: variant.id, qty: 1 }]);
    await placeOrder({
      cartId,
      email: 'buyer@example.com',
      paymentMethod: 'purchase_order',
      poNumber: 'PO-2',
    });
    const after = await readCartById(cartId);
    expect(after.lines).toEqual([]);
    await expect(
      placeOrder({
        cartId,
        email: 'buyer@example.com',
        paymentMethod: 'purchase_order',
        poNumber: 'PO-2',
      }),
    ).rejects.toThrow(OrderError);
  });

  it('refuses a PO order with no PO number', async () => {
    const variant = await variantBySku('TB-DIAG-9600-SGL');
    const cartId = await newCart([{ variantId: variant.id, qty: 1 }]);
    await expect(
      placeOrder({
        cartId,
        email: 'buyer@example.com',
        paymentMethod: 'purchase_order',
        poNumber: '   ',
      }),
    ).rejects.toThrow(/purchase order number is required/);
  });

  it('writes an audit row for the placement', async () => {
    const variant = await variantBySku('TB-HMI-8100-S');
    const cartId = await newCart([{ variantId: variant.id, qty: 1 }]);
    const order = await placeOrder({
      cartId,
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
    const cartId = await newCart([{ variantId: variant.id, qty: 3 }]);
    const order = await placeOrder({
      cartId,
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
  it('clears a cart on request', async () => {
    const variant = await variantBySku('TB-HMI-8700-STD');
    const cartId = await newCart([{ variantId: variant.id, qty: 1 }]);
    await clearCart(cartId);
    expect((await readCartById(cartId)).lines).toEqual([]);
    const remaining = await db.select().from(cartItems).where(eq(cartItems.cartId, cartId));
    expect(remaining).toEqual([]);
  });

  it('leaves no order without items', async () => {
    const allOrders = await db.select().from(orders);
    for (const order of allOrders) {
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      expect(items.length, order.number).toBeGreaterThan(0);
    }
  });
});
