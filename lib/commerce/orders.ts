import { timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { canReadOwnedResource, type Role } from '@/lib/auth/roles';
import { getDatabase } from '@/lib/db';
import { auditLog, orderItems, orders, productVariants, products } from '@/lib/db/schema';
import type { OrderStatus, PaymentMethod } from '@/lib/db/schema';
import type { CartLineInput } from './cart-cookie';
import { laddersForVariants } from './catalog';
import { priceLines, subtotalCents } from './pricing';
import { firstRow } from '@/lib/db/rows';

export interface PlaceOrderInput {
  /** Variant ids and quantities only. Prices are resolved here, never passed. */
  lines: readonly CartLineInput[];
  email: string;
  companyName?: string | undefined;
  userId?: string | undefined;
  paymentMethod: PaymentMethod;
  poNumber?: string | undefined;
}

export interface PlacedOrder {
  id: string;
  number: string;
  /** Belongs in the confirmation URL. Never render it on the page itself. */
  accessToken: string;
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
  if (input.lines.length === 0) throw new OrderError('cart is empty');

  if (input.paymentMethod === 'purchase_order' && !input.poNumber?.trim()) {
    throw new OrderError('a purchase order number is required for the PO path');
  }

  const variantIds = input.lines.map((l) => l.variantId);
  const ladders = await laddersForVariants(variantIds);
  // Any line whose variant no longer exists is refused rather than skipped:
  // silently dropping a line from an order is worse than not placing it.
  for (const line of input.lines) {
    if (!ladders.has(line.variantId)) {
      throw new OrderError(`unknown variant ${line.variantId}`);
    }
  }
  const priced = priceLines(input.lines, ladders);
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

  // The order, its lines and its audit row are one unit of work. Written
  // separately, a failure or an instance dying mid-loop leaves a persisted
  // order whose subtotal does not match the lines anybody can see — which is
  // worse than no order at all, because it looks complete.
  const number = await nextOrderNumber();
  const lineValues = priced.map((line) => {
    const snapshot = snapshots.get(line.variantId);
    if (!snapshot) throw new OrderError(`unknown variant ${line.variantId}`);
    return {
      variantId: line.variantId,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
      productNameSnapshot: `${snapshot.productName} — ${snapshot.tier}`,
      variantSkuSnapshot: snapshot.variantSku,
    };
  });

  const order = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(orders)
      .values({
        number,
        userId: input.userId ?? null,
        email: input.email,
        companyName: input.companyName ?? null,
        status,
        paymentMethod: input.paymentMethod,
        subtotalCents: total,
        poNumber: input.poNumber?.trim() ?? null,
      })
      .returning();
    const created = inserted[0];
    if (!created) throw new OrderError('could not create order');

    // One statement rather than one per line.
    await tx.insert(orderItems).values(
      lineValues.map((line) => ({ ...line, orderId: created.id })),
    );

    await tx.insert(auditLog).values({
      actor: input.userId ? `user:${input.userId}` : 'guest',
      action: 'order.placed',
      resource: `order:${created.id}`,
      after: {
        number: created.number,
        status,
        paymentMethod: input.paymentMethod,
        subtotalCents: total,
        lineCount: lineValues.length,
      },
    });

    return created;
  });

  return {
    id: order.id,
    number: order.number,
    accessToken: order.accessToken,
    status,
    subtotalCents: total,
  };
}

export type MarkPaidOutcome =
  | { status: 'paid'; orderNumber: string }
  | { status: 'already_paid'; orderNumber: string }
  | { status: 'not_found' }
  | { status: 'amount_mismatch'; expectedCents: number; paidCents: number }
  | { status: 'not_payable'; current: OrderStatus };

/**
 * Records a card payment.
 *
 * Three properties this needs and did not have, because until now nothing
 * called it outside a test:
 *
 *  - **Idempotent.** Stripe retries webhooks. The compare-and-set on
 *    `status = 'pending_payment'` means a redelivery reports `already_paid`
 *    instead of writing a second audit row and a second "paid" event.
 *  - **Amount-checked.** The order's own `subtotal_cents` is the authority.
 *    A payment for a different amount is refused and surfaced rather than
 *    accepted — the failure mode otherwise is a customer paying $1 for a
 *    $3,870 order and the system agreeing.
 *  - **State-checked.** Only a `pending_payment` order becomes paid. A
 *    cancelled or fulfilled one is left alone.
 */
export async function markOrderPaid(
  orderId: string,
  stripeSessionId: string,
  paidAmountCents?: number,
): Promise<MarkPaidOutcome> {
  const db = await getDatabase();

  const existing = firstRow<{
    id: string;
    number: string;
    status: OrderStatus;
    subtotal_cents: number;
    stripe_session_id: string | null;
  }>(
    await db.execute(sql`
      select id, number, status::text as status, subtotal_cents, stripe_session_id
      from orders where id = ${orderId}::uuid limit 1
    `),
  );
  if (!existing) return { status: 'not_found' };

  if (existing.status === 'paid') {
    return { status: 'already_paid', orderNumber: existing.number };
  }
  if (existing.status !== 'pending_payment') {
    return { status: 'not_payable', current: existing.status };
  }
  if (
    typeof paidAmountCents === 'number' &&
    paidAmountCents !== existing.subtotal_cents
  ) {
    return {
      status: 'amount_mismatch',
      expectedCents: existing.subtotal_cents,
      paidCents: paidAmountCents,
    };
  }

  return db.transaction(async (tx) => {
    const moved = await tx
      .update(orders)
      .set({ status: 'paid', stripeSessionId, updatedAt: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
      .returning({ number: orders.number });

    // A concurrent delivery won the race. Not an error — the order is paid.
    if (moved.length === 0) {
      return { status: 'already_paid', orderNumber: existing.number } as MarkPaidOutcome;
    }

    await tx.insert(auditLog).values({
      actor: 'system:stripe',
      action: 'order.paid',
      resource: `order:${orderId}`,
      before: { status: existing.status },
      after: { status: 'paid', stripeSessionId, amountCents: existing.subtotal_cents },
    });

    return { status: 'paid', orderNumber: moved[0]!.number } as MarkPaidOutcome;
  });
}

/** Marks a card order as failed so it is not left looking pending forever. */
export async function markOrderPaymentFailed(orderId: string): Promise<boolean> {
  const db = await getDatabase();
  const moved = await db
    .update(orders)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment')))
    .returning({ id: orders.id });
  if (moved.length === 0) return false;
  await db.insert(auditLog).values({
    actor: 'system:stripe',
    action: 'order.payment_failed',
    resource: `order:${orderId}`,
    after: { status: 'cancelled' },
  });
  return true;
}

export interface OrderReader {
  /** The access token from the confirmation URL, when there is one. */
  accessToken?: string | undefined;
  /** The signed-in viewer, when there is one. */
  viewerId?: string | undefined;
  viewerRole?: Role | undefined;
}

/**
 * Loads an order for someone who has proved they may read it.
 *
 * Three ways to qualify, and nothing else: the unguessable access token from
 * the confirmation link, being the signed-in owner, or being staff. The order
 * number alone is not one of them — it comes from a sequence, so treating it
 * as a key means anybody who places one order can read every order.
 *
 * Returns null for "no such order" and for "not yours" alike, so the caller
 * renders a 404 either way and the endpoint never confirms which numbers exist.
 */
export async function getOrderForReader(number: string, reader: OrderReader) {
  const db = await getDatabase();
  const rows = await db.select().from(orders).where(eq(orders.number, number)).limit(1);
  const order = rows[0];
  if (!order) return null;

  const byToken =
    typeof reader.accessToken === 'string' &&
    reader.accessToken.length > 0 &&
    timingSafeEqualString(reader.accessToken, order.accessToken);

  const byOwnership =
    order.userId !== null &&
    canReadOwnedResource(reader.viewerRole ?? null, reader.viewerId ?? null, order.userId);

  if (!byToken && !byOwnership) return null;

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  return { order, items };
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Unconditional read, for callers that have already decided.
 *
 * Only the Stripe webhook uses this: it authenticates by signature rather than
 * by session, and has no viewer to check against.
 */
export async function getOrderByNumberUnchecked(number: string) {
  const db = await getDatabase();
  const rows = await db.select().from(orders).where(eq(orders.number, number)).limit(1);
  const order = rows[0];
  if (!order) return null;
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  return { order, items };
}
