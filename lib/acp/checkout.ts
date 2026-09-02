import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase } from '@/lib/db';
import { firstRow, toRows } from '@/lib/db/rows';
import { quoteEvents, quoteLineItems, quotes } from '@/lib/db/schema';
import { writeAudit } from '@/lib/agent/audit';
import { canApproveQuotes, canReadOwnedResource, type Role } from '@/lib/auth/roles';
import {
  assertTransition,
  QuoteTransitionError,
  type QUOTE_STATUSES,
} from '@/lib/commerce/quote-state';

type QuoteStatus = (typeof QUOTE_STATUSES)[number];
import { nextQuoteNumber } from '@/lib/agent/tools';
import { priceLines, subtotalCents } from '@/lib/commerce/pricing';
import { laddersForVariants } from '@/lib/commerce/catalog';

/**
 * ACP-shaped checkout sessions.
 *
 * ACP models a checkout as a stateful session an agent creates, reads, updates
 * and completes. TagBridge maps that onto the thing industrial buying actually
 * is: a session *is* a quote. Create drafts one, update re-prices it, and
 * complete converts it to a purchase order — there is no card path here, and
 * the session says so rather than failing at the last step.
 *
 * The mapping is deliberate rather than a shortcut. ACP's status vocabulary
 * already contains `pending_approval`, which is exactly the state an
 * agent-drafted quote lands in, so an ACP client learns "a human has to look
 * at this" from a status it already understands.
 *
 * The price rule holds here as it does everywhere: `CheckoutSessionCreateRequest`
 * in ACP permits an item to carry a `unit_amount`, and this implementation
 * refuses one. A caller-supplied price is rejected, not ignored.
 */

export const ACP_VERSION = '2026-04-17';

const lineItemSchema = z
  .object({
    // ACP calls it `item`; the id inside is our variant id.
    item: z.object({ id: z.string().uuid() }).strict(),
    quantity: z.number().int().min(1).max(9999),
  })
  .strict();

export const createSessionSchema = z
  .object({
    line_items: z.array(lineItemSchema).min(1).max(50),
    currency: z.literal('USD'),
    capabilities: z.object({}).passthrough().optional(),
    buyer: z
      .object({ email: z.string().email().optional() })
      .passthrough()
      .optional(),
  })
  .strict();

export const updateSessionSchema = z
  .object({ line_items: z.array(lineItemSchema).min(1).max(50) })
  .strict();

export type AcpStatus =
  | 'ready_for_payment'
  | 'pending_approval'
  | 'completed'
  | 'canceled'
  | 'expired';

export interface AcpTotal {
  type: string;
  display_text: string;
  amount: number;
}

export interface AcpSession {
  id: string;
  protocol: { version: string };
  status: AcpStatus;
  currency: string;
  line_items: {
    id: string;
    item: { id: string; name: string; unit_amount: number };
    quantity: number;
    totals: AcpTotal[];
  }[];
  fulfillment_options: unknown[];
  totals: AcpTotal[];
  messages: { type: string; content_type: string; content: string; severity?: string }[];
  links: { type: string; url: string }[];
  capabilities: { payment: { handlers: unknown[] } };
}

/**
 * Who is asking.
 *
 * Every session call takes one. The handlers used to resolve the viewer and
 * then drop it, so any signed-in user could read, re-price and cancel anyone
 * else's session — authentication without authorization. Making the identity a
 * required argument means the check cannot be forgotten by a later caller,
 * because there is nothing to pass otherwise.
 */
export interface AcpActor {
  userId: string;
  role: Role;
}

/** Staff may act on any session; a buyer only on their own. */
function mayAct(actor: AcpActor, ownerId: string): boolean {
  return canReadOwnedResource(actor.role, actor.userId, ownerId);
}

export class AcpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly param?: string,
  ) {
    super(message);
  }
}

/** ACP's error envelope, so a client can branch on `code` rather than prose. */
export function acpErrorBody(error: AcpError) {
  return {
    type: error.status >= 500 ? 'service_error' : 'invalid_request',
    code: error.code,
    message: error.message,
    ...(error.param ? { param: error.param } : {}),
  };
}

/**
 * Prices the requested lines from `price_tiers`.
 *
 * The only place a session's money comes from. A caller cannot influence it
 * beyond choosing a variant and a quantity.
 */
async function price(lines: readonly { variantId: string; qty: number }[]) {
  const ids = [...new Set(lines.map((l) => l.variantId))];
  const ladders = await laddersForVariants(ids);

  const missing = ids.filter((id) => !ladders.has(id));
  if (missing.length > 0) {
    throw new AcpError(
      'item_not_found',
      `no purchasable item for ${missing.join(', ')}`,
      404,
      'line_items',
    );
  }

  const priced = priceLines(
    lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
    ladders,
  );

  const db = await getDatabase();
  const names = toRows<{ id: string; sku: string; name: string }>(
    await db.execute(sql`
      select v.id, v.sku, p.name
      from product_variants v join products p on p.id = v.product_id
      where v.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    `),
  );
  const byId = new Map(names.map((n) => [n.id, n]));
  return { priced, byId };
}

function totalsFor(subtotal: number): AcpTotal[] {
  return [
    { type: 'items_base_amount', display_text: 'Items', amount: subtotal },
    { type: 'subtotal', display_text: 'Subtotal', amount: subtotal },
    // No tax engine on this deployment. Reporting zero rather than omitting
    // the row makes it visible that tax was considered and is not included,
    // instead of leaving an agent to assume it was folded into the total.
    { type: 'tax', display_text: 'Tax (not calculated on this deployment)', amount: 0 },
    { type: 'fulfillment', display_text: 'Delivery (electronic)', amount: 0 },
    { type: 'total', display_text: 'Total', amount: subtotal },
  ];
}

function sessionFrom(
  quote: { id: string; number: string; status: string; subtotalCents: number },
  lines: { id: string; variantId: string; qty: number; unitPriceCents: number; sku: string; name: string }[],
  origin: string,
): AcpSession {
  const pendingApproval = quote.status === 'pending_approval';

  const messages: AcpSession['messages'] = [
    {
      type: 'info',
      content_type: 'plain',
      content:
        'Checkout here is quote-shaped. This session is quote ' +
        `${quote.number}; completing it raises a purchase order rather than charging a card.`,
    },
  ];
  if (pendingApproval) {
    messages.push({
      type: 'info',
      severity: 'medium',
      content_type: 'plain',
      content:
        'This quote was drafted by an agent and is awaiting human approval. ' +
        'It cannot be completed until someone with the sales or admin role approves it.',
    });
  }

  return {
    id: quote.id,
    protocol: { version: ACP_VERSION },
    status: pendingApproval ? 'pending_approval' : 'ready_for_payment',
    currency: 'USD',
    line_items: lines.map((line) => ({
      id: line.id,
      item: { id: line.variantId, name: `${line.name} (${line.sku})`, unit_amount: line.unitPriceCents },
      quantity: line.qty,
      totals: [
        {
          type: 'total',
          display_text: 'Line total',
          amount: line.unitPriceCents * line.qty,
        },
      ],
    })),
    // Software licences: nothing ships.
    fulfillment_options: [],
    totals: totalsFor(quote.subtotalCents),
    messages,
    links: [
      { type: 'terms_of_use', url: `${origin}/terms` },
      { type: 'support', url: `${origin}/contact` },
    ],
    capabilities: {
      // Empty, and truthfully so: no card handler is configured.
      payment: { handlers: [] },
    },
  };
}

async function loadSession(
  id: string,
  origin: string,
  actor: AcpActor,
): Promise<AcpSession> {
  const db = await getDatabase();
  const quote = firstRow<{
    id: string;
    number: string;
    status: string;
    subtotal_cents: number;
    user_id: string;
  }>(
    await db.execute(sql`
      select id, number, status::text as status, subtotal_cents, user_id
      from quotes where id = ${id}::uuid limit 1
    `),
  );
  // 404 rather than 403 for both misses: a 403 would confirm the id is real,
  // which hands an attacker the enumeration they were missing.
  if (!quote || !mayAct(actor, quote.user_id)) {
    throw new AcpError('session_not_found', `no checkout session ${id}`, 404);
  }

  const lines = toRows<{
    id: string;
    variant_id: string;
    qty: number;
    unit_price_cents: number;
    sku: string;
    name: string;
  }>(
    await db.execute(sql`
      select l.id, l.variant_id, l.qty, l.unit_price_cents, v.sku, p.name
      from quote_line_items l
      join product_variants v on v.id = l.variant_id
      join products p on p.id = v.product_id
      where l.quote_id = ${id}::uuid
      order by l.id
    `),
  );

  return sessionFrom(
    {
      id: quote.id,
      number: quote.number,
      status: quote.status,
      subtotalCents: quote.subtotal_cents,
    },
    lines.map((l) => ({
      id: l.id,
      variantId: l.variant_id,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      sku: l.sku,
      name: l.name,
    })),
    origin,
  );
}

export async function createCheckoutSession(
  input: z.infer<typeof createSessionSchema>,
  actor: AcpActor,
  origin: string,
): Promise<AcpSession> {
  const userId = actor.userId;
  const lines = input.line_items.map((l) => ({ variantId: l.item.id, qty: l.quantity }));
  const { priced, byId } = await price(lines);
  const subtotal = subtotalCents(priced);

  const db = await getDatabase();
  const created = await db
    .insert(quotes)
    .values({
      number: await nextQuoteNumber(),
      userId,
      // A session created over the protocol is not agent-drafted by
      // definition — the caller may be a human's own script — so it starts
      // ready rather than pending. The agent path routes through createQuote,
      // which sets pending_approval.
      status: 'draft',
      subtotalCents: subtotal,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      agentNotes: 'Created through the ACP checkout session endpoint.',
    })
    .returning({ id: quotes.id, number: quotes.number, status: quotes.status });

  const quote = created[0];
  if (!quote) throw new AcpError('internal_error', 'could not create the session', 500);

  await db.insert(quoteLineItems).values(
    priced.map((line) => ({
      quoteId: quote.id,
      variantId: line.variantId,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
    })),
  );

  await db.insert(quoteEvents).values({
    quoteId: quote.id,
    type: 'drafted',
    actor: 'system',
    payload: { via: 'acp', lines: priced.length, subtotalCents: subtotal },
  });

  await writeAudit({
    actor: `acp:${userId}`,
    action: 'checkout_session.create',
    resource: `quote:${quote.id}`,
    before: null,
    after: { subtotalCents: subtotal, lines: priced.length },
  });

  void byId;
  return loadSession(quote.id, origin, actor);
}

export async function getCheckoutSession(
  id: string,
  origin: string,
  actor: AcpActor,
): Promise<AcpSession> {
  return loadSession(id, origin, actor);
}

export async function updateCheckoutSession(
  id: string,
  input: z.infer<typeof updateSessionSchema>,
  origin: string,
  actor: AcpActor,
): Promise<AcpSession> {
  const db = await getDatabase();
  const quote = firstRow<{ id: string; status: string; user_id: string }>(
    await db.execute(
      sql`select id, status::text as status, user_id from quotes where id = ${id}::uuid limit 1`,
    ),
  );
  if (!quote || !mayAct(actor, quote.user_id)) {
    throw new AcpError('session_not_found', `no checkout session ${id}`, 404);
  }
  if (quote.status !== 'draft') {
    throw new AcpError(
      'session_not_modifiable',
      `session is ${quote.status} and can no longer be changed`,
      409,
    );
  }

  const lines = input.line_items.map((l) => ({ variantId: l.item.id, qty: l.quantity }));
  const { priced } = await price(lines);
  const subtotal = subtotalCents(priced);

  // Delete-then-insert in one transaction. Apart, a failure between them
  // leaves a priced quote with no lines at all — a total nobody can account
  // for, which is worse than the update simply failing.
  await db.transaction(async (tx) => {
    await tx.delete(quoteLineItems).where(sql`quote_id = ${id}::uuid`);
    await tx.insert(quoteLineItems).values(
      priced.map((line) => ({
        quoteId: id,
        variantId: line.variantId,
        qty: line.qty,
        unitPriceCents: line.unitPriceCents,
      })),
    );
    await tx
      .update(quotes)
      .set({ subtotalCents: subtotal, updatedAt: new Date() })
      .where(sql`id = ${id}::uuid`);
  });

  return loadSession(id, origin, actor);
}

export async function cancelCheckoutSession(
  id: string,
  origin: string,
  actor: AcpActor,
): Promise<AcpSession> {
  const db = await getDatabase();
  const quote = firstRow<{ status: QuoteStatus; user_id: string }>(
    await db.execute(
      sql`select status::text as status, user_id from quotes where id = ${id}::uuid limit 1`,
    ),
  );
  if (!quote || !mayAct(actor, quote.user_id)) {
    throw new AcpError('session_not_found', `no checkout session ${id}`, 404);
  }

  // Through the state machine, like every other caller. Cancelling used to be
  // a raw UPDATE, so a converted or already-rejected quote could be
  // "cancelled" repeatedly — the one endpoint an external agent talks to was
  // the one place the rules did not apply.
  let transition;
  try {
    transition = assertTransition(quote.status, 'rejected', {
      isOwner: quote.user_id === actor.userId,
      isApprover: canApproveQuotes(actor.role),
      isSystem: false,
    });
  } catch (error) {
    if (error instanceof QuoteTransitionError) {
      throw new AcpError('session_not_cancelable', error.message, 409);
    }
    throw error;
  }

  await db.transaction(async (tx) => {
    const moved = await tx
      .update(quotes)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(sql`id = ${id}::uuid and status = ${quote.status}`)
      .returning({ id: quotes.id });

    // Somebody else moved it between the read and the write.
    if (moved.length === 0) {
      throw new AcpError('session_changed', 'the session changed while you were cancelling it', 409);
    }

    await tx.insert(quoteEvents).values({
      quoteId: id,
      type: transition.event,
      actor: 'system',
      payload: { via: 'acp', from: quote.status, to: 'rejected' },
    });
  });

  const session = await loadSession(id, origin, actor);
  return { ...session, status: 'canceled' };
}
