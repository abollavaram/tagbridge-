import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { firstRow } = await import('@/lib/db/rows');
const { auditLog, quoteEvents, quoteLineItems, quotes } = await import('@/lib/db/schema');
const {
  ACP_VERSION,
  AcpError,
  cancelCheckoutSession,
  createCheckoutSession,
  createSessionSchema,
  getCheckoutSession,
  updateCheckoutSession,
} = await import('@/lib/acp/checkout');

const ORIGIN = 'https://tagbridge.example.com';

/**
 * Validates a session against the pinned ACP schema.
 *
 * `CheckoutSessionBase` is `additionalProperties: false`, so this catches an
 * invented field as well as a missing one — which is the failure worth
 * catching, because an extra field is exactly what a client would silently
 * ignore rather than reject.
 */
function sessionValidator() {
  const schema = JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'spec-snapshots', 'acp', 'schema.agentic_checkout.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(schema, 'acp');
  return ajv.getSchema('acp#/$defs/CheckoutSessionBase')!;
}

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;
let userId: string;
let actor: { userId: string; role: 'buyer' };
let otherActor: { userId: string; role: 'buyer' };
let staffActor: { userId: string; role: 'admin' };
let variantId: string;
let secondVariantId: string;

beforeAll(async () => {
  db = await getDatabase();
  userId = firstRow<{ id: string }>(
    await db.execute(sql`select id from users where role = 'buyer' limit 1`),
  )!.id;
  const otherId = firstRow<{ id: string }>(
    await db.execute(sql`select id from users where role = 'sales' limit 1`),
  )!.id;
  const adminId = firstRow<{ id: string }>(
    await db.execute(sql`select id from users where role = 'admin' limit 1`),
  )!.id;
  actor = { userId, role: 'buyer' };
  // A different person entirely, used for the cross-user cases.
  otherActor = { userId: otherId, role: 'buyer' };
  staffActor = { userId: adminId, role: 'admin' };
  const variants = await db.execute<{ id: string }>(
    sql`select id from product_variants order by sku limit 2`,
  );
  const rows = Array.isArray(variants)
    ? (variants as { id: string }[])
    : ((variants as { rows: { id: string }[] }).rows ?? []);
  variantId = rows[0]!.id;
  secondVariantId = rows[1]!.id;
}, 180_000);

beforeEach(async () => {
  await db.delete(quoteEvents);
  await db.delete(quoteLineItems);
  await db.delete(quotes);
  await db.delete(auditLog);
});

function createInput(items: { id: string; quantity: number }[]) {
  return {
    line_items: items.map((i) => ({ item: { id: i.id }, quantity: i.quantity })),
    currency: 'USD' as const,
    capabilities: {},
  };
}

describe('sessions validate against the pinned ACP schema', () => {
  it('a created session is a valid CheckoutSessionBase', async () => {
    const validate = sessionValidator();
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 2 }]),
      actor,
      ORIGIN,
    );
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(validate(session)).toBe(true);
  });

  it('pins the protocol version it was built against', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    expect(session.protocol.version).toBe(ACP_VERSION);
    expect(ACP_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses a status from the protocol’s own vocabulary', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    expect([
      'incomplete',
      'not_ready_for_payment',
      'ready_for_payment',
      'pending_approval',
      'completed',
      'canceled',
      'expired',
    ]).toContain(session.status);
  });

  it('uses only the protocol’s total types', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const allowed = [
      'items_base_amount',
      'items_discount',
      'subtotal',
      'discount',
      'fulfillment',
      'tax',
      'fee',
      'gift_wrap',
      'tip',
      'store_credit',
      'total',
      'amount_refunded',
    ];
    for (const total of session.totals) expect(allowed, total.type).toContain(total.type);
  });
});

describe('the server prices the session', () => {
  it('computes the total from the volume breaks', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 3 }]),
      actor,
      ORIGIN,
    );
    const total = session.totals.find((t) => t.type === 'total')!;
    const line = session.line_items[0]!;
    expect(total.amount).toBe(line.item.unit_amount * 3);
    expect(total.amount).toBeGreaterThan(0);
  });

  it('refuses a caller-supplied unit_amount at the schema', () => {
    const parsed = createSessionSchema.safeParse({
      line_items: [{ item: { id: variantId, unit_amount: 1 }, quantity: 1 }],
      currency: 'USD',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a caller-supplied currency other than USD', () => {
    const parsed = createSessionSchema.safeParse({
      line_items: [{ item: { id: variantId } , quantity: 1 }],
      currency: 'EUR',
    });
    expect(parsed.success).toBe(false);
  });

  it('reports tax explicitly as zero rather than omitting it', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const tax = session.totals.find((t) => t.type === 'tax');
    expect(tax?.amount).toBe(0);
    expect(tax?.display_text).toMatch(/not calculated/i);
  });

  it('rejects an item that does not exist', async () => {
    await expect(
      createCheckoutSession(
        createInput([{ id: '00000000-0000-4000-8000-000000000000', quantity: 1 }]),
        actor,
        ORIGIN,
      ),
    ).rejects.toBeInstanceOf(AcpError);
  });
});

describe('the session is a quote', () => {
  it('says so in a message an agent can read', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    expect(session.messages.some((m) => /purchase order/i.test(m.content))).toBe(true);
  });

  it('declares no payment handler, because none is configured', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    expect(session.capabilities.payment.handlers).toEqual([]);
  });

  it('writes a real quote row', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const rows = await db.select().from(quotes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(session.id);
  });

  it('records the creation in the audit log', async () => {
    await createCheckoutSession(createInput([{ id: variantId, quantity: 1 }]), actor, ORIGIN);
    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.action === 'checkout_session.create')).toBe(true);
  });
});

describe('retrieve, update and cancel', () => {
  it('retrieves the session it created', async () => {
    const created = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const fetched = await getCheckoutSession(created.id, ORIGIN, actor);
    expect(fetched.id).toBe(created.id);
    expect(fetched.totals).toEqual(created.totals);
  });

  it('404s an unknown session', async () => {
    await expect(
      getCheckoutSession('00000000-0000-4000-8000-000000000000', ORIGIN, actor),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('re-prices on update rather than trusting the old total', async () => {
    const created = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const before = created.totals.find((t) => t.type === 'total')!.amount;

    const updated = await updateCheckoutSession(
      created.id,
      { line_items: [{ item: { id: variantId }, quantity: 5 }] },
      ORIGIN,
      actor,
    );
    const after = updated.totals.find((t) => t.type === 'total')!.amount;
    expect(after).toBeGreaterThan(before);
  });

  it('replaces the lines rather than appending them', async () => {
    const created = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const updated = await updateCheckoutSession(
      created.id,
      { line_items: [{ item: { id: secondVariantId }, quantity: 1 }] },
      ORIGIN,
      actor,
    );
    expect(updated.line_items).toHaveLength(1);
    expect(updated.line_items[0]!.item.id).toBe(secondVariantId);
  });

  it('stays valid against the schema after an update', async () => {
    const validate = sessionValidator();
    const created = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const updated = await updateCheckoutSession(
      created.id,
      { line_items: [{ item: { id: variantId }, quantity: 4 }] },
      ORIGIN,
      actor,
    );
    expect(validate(updated), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('cancels a session and says so', async () => {
    const created = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    const cancelled = await cancelCheckoutSession(created.id, ORIGIN, actor);
    expect(cancelled.status).toBe('canceled');
  });

  it('refuses to update a cancelled session', async () => {
    const created = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    await cancelCheckoutSession(created.id, ORIGIN, actor);
    await expect(
      updateCheckoutSession(
        created.id,
        { line_items: [{ item: { id: variantId }, quantity: 2 }] },
        ORIGIN,
        actor,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});


describe('a session belongs to the person who created it (F-02)', () => {
  async function mine() {
    return createCheckoutSession(createInput([{ id: variantId, quantity: 2 }]), actor, ORIGIN);
  }

  it('refuses to show another user the session', async () => {
    const session = await mine();
    // 404, not 403: a 403 would confirm the id is real.
    await expect(getCheckoutSession(session.id, ORIGIN, otherActor)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses to let another user re-price it', async () => {
    const session = await mine();
    const before = session.totals.find((t) => t.type === 'total')!.amount;

    await expect(
      updateCheckoutSession(
        session.id,
        { line_items: [{ item: { id: variantId }, quantity: 500 }] },
        ORIGIN,
        otherActor,
      ),
    ).rejects.toMatchObject({ status: 404 });

    // And the total is untouched.
    const after = await getCheckoutSession(session.id, ORIGIN, actor);
    expect(after.totals.find((t) => t.type === 'total')!.amount).toBe(before);
  });

  it('refuses to let another user cancel it', async () => {
    const session = await mine();
    await expect(cancelCheckoutSession(session.id, ORIGIN, otherActor)).rejects.toMatchObject({
      status: 404,
    });

    const after = await getCheckoutSession(session.id, ORIGIN, actor);
    expect(after.status).not.toBe('canceled');
  });

  it('lets the owner do all three', async () => {
    const session = await mine();
    await expect(getCheckoutSession(session.id, ORIGIN, actor)).resolves.toBeTruthy();
    await expect(
      updateCheckoutSession(
        session.id,
        { line_items: [{ item: { id: variantId }, quantity: 3 }] },
        ORIGIN,
        actor,
      ),
    ).resolves.toBeTruthy();
    await expect(cancelCheckoutSession(session.id, ORIGIN, actor)).resolves.toBeTruthy();
  });

  it('lets staff act on a buyer’s session', async () => {
    const session = await mine();
    await expect(getCheckoutSession(session.id, ORIGIN, staffActor)).resolves.toBeTruthy();
  });
});

describe('cancel goes through the state machine (F-05)', () => {
  it('refuses a second cancel on an already-terminal quote', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );

    await expect(cancelCheckoutSession(session.id, ORIGIN, actor)).resolves.toMatchObject({
      status: 'canceled',
    });

    // Used to return 200 "canceled" again, repeatedly, because this path
    // issued a raw UPDATE and never consulted the state machine.
    await expect(cancelCheckoutSession(session.id, ORIGIN, actor)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('writes the transition event the state machine names', async () => {
    const session = await createCheckoutSession(
      createInput([{ id: variantId, quantity: 1 }]),
      actor,
      ORIGIN,
    );
    await cancelCheckoutSession(session.id, ORIGIN, actor);

    const events = await db.select().from(quoteEvents);
    expect(events.map((e) => e.type)).toContain('quote.withdrawn');
  });
});
