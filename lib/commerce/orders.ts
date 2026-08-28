import { eq, inArray, sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { auditLog, orderItems, orders, productVariants, products } from '@/lib/db/schema';
import type { OrderStatus, PaymentMethod } from '@/lib/db/schema';
import { clearCart, readCartById } from './cart';
import { laddersForVariants } from './catalog';
import { priceLines, subtotalCents } from './pricing';
import { firstRow } from '@/lib/db/rows';

export interface PlaceOrderInput {
  cartId: string;
  email: string;
  companyName?: string | undefined;
  userId?: string | undefined;
  paymentMethod: PaymentMethod;
  poNumber?: string | undefined;
}

export interface PlacedOrder {
  id: string;
  number: string;
  status: OrderStatus;
  subtotalCents: number;
}

export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

/**
 * `TB-YYYYMM-001234` — readable on a purchase order and unique by construction.
 *
 * The counter comes from a Postgres sequence, not from randomness. A random
 * suffix wide enough to feel safe still collides at volume, and `orders.number`
 * is unique, so the failure mode would be a rejected order at checkout.
 */
export function formatOrderNumber(sequence: number, now = new Date()): string {
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `TB-${stamp}-${String(sequence).padStart(6, '0')}`;
}

export async function nextOrderNumber(now = new Date()): Promise<string> {
  const db = await getDatabase();
  const result = await db.execute<{ value: string }>(
    sql`select nextval('order_number_seq')::text as value`,
  );
  const value = firstRow<{ value: string }>(result)?.value;
  if (!value) throw new OrderError('could not allocate an order number');
  return formatOrderNumber(Number(value), now);
}

/**
 * Turns a cart into an order.
 *
 * Every unit price is resolved here from `price_tiers` at the moment the order
 * is placed — the cart carries quantities only, and no caller supplies a price.
 * Product name and variant SKU are snapshotted onto the line, because the
 * catalog may change afterwards and the order may not.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlacedOrder> {
  const db = await getDatabase();
  const cart = await readCartById(input.cartId);
  if (cart.lines.length === 0) throw new OrderError('cart is empty');

  if (input.paymentMethod === 'purchase_order' && !input.poNumber?.trim()) {
    throw new OrderError('a purchase order number is required for the PO path');
  }

  const variantIds = cart.lines.map((l) => l.variantId);
  const ladders = await laddersForVariants(variantIds);
  const priced = priceLines(
    cart.lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
    ladders,
  );
  const total = subtotalCents(priced);

  const snapshotRows = await db
    .select({
      variantId: productVariants.id,
      variantSku: productVariants.sku,
      productName: products.name,
      tier: productVariants.tier,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, variantIds));
  const snapshots = new Map(snapshotRows.map((r) => [r.variantId, r]));

  const status: OrderStatus =
    input.paymentMethod === 'purchase_order' ? 'po_received' : 'pending_payment';

  const inserted = await db
    .insert(orders)
    .values({
      number: await nextOrderNumber(),
      userId: input.userId ?? null,
      email: input.email,
      companyName: input.companyName ?? null,
      status,
      paymentMethod: input.paymentMethod,
      subtotalCents: total,
      poNumber: input.poNumber?.trim() ?? null,
    })
    .returning();
  const order = inserted[0];
  if (!order) throw new OrderError('could not create order');

  for (const line of priced) {
    const snapshot = snapshots.get(line.variantId);
    if (!snapshot) throw new OrderError(`unknown variant ${line.variantId}`);
    await db.insert(orderItems).values({
      orderId: order.id,
      variantId: line.variantId,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
      productNameSnapshot: `${snapshot.productName} — ${snapshot.tier}`,
      variantSkuSnapshot: snapshot.variantSku,
    });
  }

  await db.insert(auditLog).values({
    actor: input.userId ? `user:${input.userId}` : 'guest',
    action: 'order.placed',
    resource: `order:${order.id}`,
    after: {
      number: order.number,
      status,
      paymentMethod: input.paymentMethod,
      subtotalCents: total,
      lineCount: priced.length,
    },
  });

  await clearCart(input.cartId);

  return { id: order.id, number: order.number, status, subtotalCents: total };
}

export async function markOrderPaid(
  orderId: string,
  stripeSessionId: string,
): Promise<void> {
  const db = await getDatabase();
  await db
    .update(orders)
    .set({ status: 'paid', stripeSessionId, updatedAt: new Date() })
    .where(eq(orders.id, orderId));
  await db.insert(auditLog).values({
    actor: 'system:stripe',
    action: 'order.paid',
    resource: `order:${orderId}`,
    after: { stripeSessionId },
  });
}

export async function getOrderByNumber(number: string) {
  const db = await getDatabase();
  const rows = await db.select().from(orders).where(eq(orders.number, number)).limit(1);
  const order = rows[0];
  if (!order) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  return { order, items };
}
