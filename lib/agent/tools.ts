import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDatabase } from '@/lib/db';
import { firstRow, toRows } from '@/lib/db/rows';
import { quoteEvents, quoteLineItems, quotes } from '@/lib/db/schema';
import { resolveCompatibility } from '@/lib/compatibility/resolver';
import {
  compatibilityRequestSchema,
  DESTINATIONS,
  SOURCE_FAMILIES,
  TRANSPORTS,
} from '@/lib/compatibility/types';
import { lineItemsRequestSchema, priceLines, subtotalCents } from '@/lib/commerce/pricing';
import {
  assertTransition,
  QUOTE_STATUSES,
  stateAfterSubmit,
} from '@/lib/commerce/quote-state';

type QuoteStatus = (typeof QUOTE_STATUSES)[number];
import { canApproveQuotes } from '@/lib/auth/roles';
import { search } from '@/lib/search/pipeline';
import { writeAudit } from './audit';
import { wrapUntrusted } from './guardrails';
import type { AgentTool } from './types';

/**
 * The tools.
 *
 * Two rules hold across all six and are the reason the loop can stay simple:
 *
 *  - Authorization is re-derived inside the tool from `context.principal`,
 *    which comes from the session. Nothing the model sends can name an actor,
 *    an owner, or a role, because those fields do not exist in any input
 *    schema. The model's request is a suggestion about *what* to do; it is
 *    never evidence about *who* is asking.
 *  - Money is computed here, from `price_tiers`, every time. No input schema
 *    accepts a price, so a model trying to set one fails validation before any
 *    code runs.
 */

/** Turns a zod object schema into the JSON Schema the model is shown. */
function jsonSchemaOf(shape: Record<string, unknown>, required: string[]) {
  return { type: 'object', properties: shape, required, additionalProperties: false };
}

/* ------------------------------------------------------------ searchProducts */

const searchInput = z
  .object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const searchOutput = z.object({
  hits: z.array(
    z.object({
      variantId: z.string().uuid().nullable(),
      sku: z.string(),
      name: z.string(),
      category: z.string(),
      /** Catalogue prose, delimited. Data for the model to read, never instruction. */
      description: z.string(),
      reasons: z.array(z.string()),
    }),
  ),
  count: z.number().int(),
});

export const searchProductsTool: AgentTool<
  z.infer<typeof searchInput>,
  z.infer<typeof searchOutput>
> = {
  name: 'searchProducts',
  description:
    'Search the catalogue by symptom, protocol, vendor or part number. Returns products with their smallest variant id, which is what a quote line refers to.',
  inputSchema: searchInput,
  outputSchema: searchOutput,
  allowedRoles: ['guest', 'buyer', 'sales', 'admin'],
  jsonSchema: jsonSchemaOf(
    {
      query: { type: 'string', description: 'What the buyer is looking for, in their words.' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    ['query'],
  ),
  async execute(input) {
    const result = await search(input.query, { limit: input.limit ?? 5 });
    if (result.hits.length === 0) return { hits: [], count: 0 };

    const db = await getDatabase();
    const rows = toRows<{
      product_id: string;
      variant_id: string;
      description: string;
    }>(
      await db.execute(sql`
        select distinct on (p.id)
          p.id as product_id, v.id as variant_id, p.description
        from products p
        join product_variants v on v.product_id = p.id
        where p.id in (${sql.join(
          result.hits.map((h) => sql`${h.id}::uuid`),
          sql`, `,
        )})
        order by p.id, v.tag_capacity asc
      `),
    );
    const byProduct = new Map(rows.map((r) => [r.product_id, r]));

    return {
      hits: result.hits.map((hit) => {
        const extra = byProduct.get(hit.id);
        return {
          variantId: extra?.variant_id ?? null,
          sku: hit.sku,
          name: hit.name,
          category: hit.category,
          description: wrapUntrusted(extra?.description ?? ''),
          reasons: hit.reasons,
        };
      }),
      count: result.hits.length,
    };
  },
};

/* ------------------------------------------------------ resolveCompatibility */

const compatibilityOutput = z.object({
  bundle: z.array(
    z.object({ role: z.string(), sku: z.string(), name: z.string(), why: z.string() }),
  ),
  licenseTier: z.string(),
  gaps: z.array(z.object({ severity: z.string(), detail: z.string() })),
  rulesApplied: z.array(z.string()),
});

export const resolveCompatibilityTool: AgentTool<unknown, z.infer<typeof compatibilityOutput>> = {
  name: 'resolveCompatibility',
  description:
    'Given a source system, a destination and a tag count, return the bundle of products that connects them, the licence tier, and any gaps. Deterministic: the rules are code, not judgement.',
  inputSchema: compatibilityRequestSchema,
  outputSchema: compatibilityOutput,
  allowedRoles: ['guest', 'buyer', 'sales', 'admin'],
  jsonSchema: jsonSchemaOf(
    {
      sourceDevice: { type: 'string', enum: [...SOURCE_FAMILIES] },
      destinationSystem: { type: 'string', enum: [...DESTINATIONS] },
      tagCount: { type: 'integer', minimum: 1 },
      transport: { type: 'string', enum: [...TRANSPORTS] },
      redundancyRequired: { type: 'boolean' },
      intermittentLink: { type: 'boolean' },
      legacyFirmware: { type: 'boolean' },
    },
    ['sourceDevice', 'destinationSystem', 'tagCount'],
  ),
  async execute(input) {
    const result = resolveCompatibility(input);

    // The resolver deals in SKUs because its rules are about capability, not
    // marketing. The buyer needs the name, so it is joined here rather than
    // duplicated into the rule table where it would drift.
    const db = await getDatabase();
    const names = new Map<string, string>();
    if (result.bundle.length > 0) {
      const rows = toRows<{ sku: string; name: string }>(
        await db.execute(sql`
          select sku, name from products where sku in (${sql.join(
            result.bundle.map((item) => sql`${item.sku}`),
            sql`, `,
          )})
        `),
      );
      for (const row of rows) names.set(row.sku, row.name);
    }

    return {
      bundle: result.bundle.map((item) => ({
        role: item.role,
        sku: item.sku,
        name: names.get(item.sku) ?? item.sku,
        why: item.reason,
      })),
      licenseTier: result.licenseTier,
      gaps: result.gaps.map((gap) => ({
        severity: gap.severity,
        detail: `${gap.message} ${gap.remedy}`.trim(),
      })),
      rulesApplied: [...result.rulesApplied],
    };
  },
};

/* ----------------------------------------------------------------- getPricing */

const pricingInput = z
  .object({ variantId: z.string().uuid(), qty: z.number().int().min(1).max(9999) })
  .strict();

const pricingOutput = z.object({
  variantId: z.string(),
  sku: z.string(),
  qty: z.number().int(),
  unitPriceCents: z.number().int(),
  lineTotalCents: z.number().int(),
  nextBreakAtQty: z.number().int().nullable(),
});

export const getPricingTool: AgentTool<
  z.infer<typeof pricingInput>,
  z.infer<typeof pricingOutput>
> = {
  name: 'getPricing',
  description:
    'The server-computed price for a variant at a quantity, including the next volume break. This is the only source of a price; you may report what it returns and must never state a price it did not.',
  inputSchema: pricingInput,
  outputSchema: pricingOutput,
  allowedRoles: ['guest', 'buyer', 'sales', 'admin'],
  jsonSchema: jsonSchemaOf(
    { variantId: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
    ['variantId', 'qty'],
  ),
  async execute(input) {
    const priced = await priceVariants([input]);
    const line = priced[0];
    if (!line) throw new ToolNotFound(`no variant ${input.variantId}`);

    const db = await getDatabase();
    const next = firstRow<{ min_qty: number }>(
      await db.execute(sql`
        select min_qty from price_tiers
        where variant_id = ${input.variantId}::uuid and min_qty > ${input.qty}
        order by min_qty asc limit 1
      `),
    );

    return {
      variantId: line.variantId,
      sku: line.sku,
      qty: line.qty,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
      nextBreakAtQty: next?.min_qty ?? null,
    };
  },
};

export class ToolNotFound extends Error {}

/**
 * Quote numbers come from a Postgres sequence.
 *
 * The same reasoning as order numbers, and for the same reason it was worth
 * fixing there: `quotes.number` is unique, so a collision is not a cosmetic
 * problem, it is an agent run that did all the work and then threw on the
 * final insert.
 */
export async function nextQuoteNumber(now = new Date()): Promise<string> {
  const db = await getDatabase();
  const row = firstRow<{ value: string }>(
    await db.execute(sql`select nextval('quote_number_seq')::text as value`),
  );
  if (!row) throw new Error('could not allocate a quote number');
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `Q-${stamp}-${String(row.value).padStart(6, '0')}`;
}

interface PricedVariant {
  variantId: string;
  sku: string;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/** Prices lines from `price_tiers`. The only place a quote's money comes from. */
async function priceVariants(
  lines: readonly { variantId: string; qty: number }[],
): Promise<PricedVariant[]> {
  const db = await getDatabase();
  const ids = [...new Set(lines.map((l) => l.variantId))];
  const rows = toRows<{ id: string; sku: string; min_qty: number; unit_price_cents: number }>(
    await db.execute(sql`
      select v.id, v.sku, t.min_qty, t.unit_price_cents
      from product_variants v
      join price_tiers t on t.variant_id = v.id
      where v.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      order by v.id, t.min_qty asc
    `),
  );

  const byVariant = new Map<string, { sku: string; tiers: { minQty: number; unitPriceCents: number }[] }>();
  for (const row of rows) {
    const entry = byVariant.get(row.id) ?? { sku: row.sku, tiers: [] };
    entry.tiers.push({ minQty: row.min_qty, unitPriceCents: row.unit_price_cents });
    byVariant.set(row.id, entry);
  }

  return lines.map((line) => {
    const found = byVariant.get(line.variantId);
    if (!found) throw new ToolNotFound(`no variant ${line.variantId}`);
    const ladder = new Map([[line.variantId, found.tiers]]);
    const [priced] = priceLines([{ variantId: line.variantId, qty: line.qty }], ladder);
    if (!priced) throw new ToolNotFound(`no variant ${line.variantId}`);
    return { ...priced, sku: found.sku };
  });
}

/* ---------------------------------------------------------------- createQuote */

const createQuoteInput = z
  .object({
    lines: lineItemsRequestSchema,
    notes: z.string().max(2000).optional(),
  })
  .strict();

const createQuoteOutput = z.object({
  quoteId: z.string(),
  number: z.string(),
  status: z.string(),
  subtotalCents: z.number().int(),
  requiresApproval: z.boolean(),
  lines: z.array(
    z.object({
      variantId: z.string(),
      sku: z.string(),
      qty: z.number().int(),
      unitPriceCents: z.number().int(),
      lineTotalCents: z.number().int(),
    }),
  ),
});

export const createQuoteTool: AgentTool<
  z.infer<typeof createQuoteInput>,
  z.infer<typeof createQuoteOutput>
> = {
  name: 'createQuote',
  description:
    'Draft a quote from line items. Give only variant ids and quantities — every price is computed by the server. A quote above the approval threshold enters pending_approval and cannot be sent by you.',
  inputSchema: createQuoteInput,
  outputSchema: createQuoteOutput,
  // A guest has nowhere to hang a quote: it is owned by a user row.
  allowedRoles: ['buyer', 'sales', 'admin'],
  jsonSchema: jsonSchemaOf(
    {
      lines: {
        type: 'array',
        minItems: 1,
        items: jsonSchemaOf(
          { variantId: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
          ['variantId', 'qty'],
        ),
      },
      notes: { type: 'string' },
    },
    ['lines'],
  ),
  async execute(input, context) {
    const priced = await priceVariants(input.lines);
    const subtotal = subtotalCents(priced);
    // The agent never chooses this. The threshold decides, from the number the
    // server computed, and an agent-drafted quote can only ever land in draft
    // or pending_approval.
    const status = stateAfterSubmit(subtotal, 'agent');

    const db = await getDatabase();
    const created = await db
      .insert(quotes)
      .values({
        number: await nextQuoteNumber(),
        userId: context.principal.userId,
        status,
        subtotalCents: subtotal,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        agentNotes: input.notes ?? null,
      })
      .returning({ id: quotes.id, number: quotes.number, status: quotes.status });

    const quote = created[0];
    if (!quote) throw new Error('quote insert returned nothing');

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
      type: status === 'pending_approval' ? 'submitted_for_approval' : 'drafted',
      actor: 'agent',
      payload: { runId: context.runId, subtotalCents: subtotal, lines: priced.length },
    });

    await writeAudit({
      actor: `agent:${context.runId}`,
      action: 'quote.create',
      resource: `quote:${quote.id}`,
      before: null,
      after: { status, subtotalCents: subtotal, lines: priced.length },
    });

    return {
      quoteId: quote.id,
      number: quote.number,
      status,
      subtotalCents: subtotal,
      requiresApproval: status === 'pending_approval',
      lines: priced,
    };
  },
};

/* ---------------------------------------------------------- updateQuoteStatus */

const updateStatusInput = z
  .object({
    quoteId: z.string().uuid(),
    to: z.enum(QUOTE_STATUSES),
    reason: z.string().max(500).optional(),
  })
  .strict();

const updateStatusOutput = z.object({
  quoteId: z.string(),
  from: z.string(),
  to: z.string(),
  event: z.string(),
});

export const updateQuoteStatusTool: AgentTool<
  z.infer<typeof updateStatusInput>,
  z.infer<typeof updateStatusOutput>
> = {
  name: 'updateQuoteStatus',
  description:
    'Move a quote to another state. Illegal transitions are refused. Approving or sending a quote requires a human with the sales or admin role — you cannot do it.',
  inputSchema: updateStatusInput,
  outputSchema: updateStatusOutput,
  allowedRoles: ['buyer', 'sales', 'admin'],
  jsonSchema: jsonSchemaOf(
    {
      quoteId: { type: 'string' },
      to: { type: 'string', enum: [...QUOTE_STATUSES] },
      reason: { type: 'string' },
    },
    ['quoteId', 'to'],
  ),
  async execute(input, context) {
    const db = await getDatabase();
    const existing = firstRow<{ id: string; status: QuoteStatus; user_id: string }>(
      await db.execute(sql`
        select id, status::text as status, user_id from quotes where id = ${input.quoteId}::uuid limit 1
      `),
    );
    if (!existing) throw new ToolNotFound(`no quote ${input.quoteId}`);

    // Ownership and approver rights come from the session, not the input.
    const transition = assertTransition(existing.status, input.to, {
      isOwner: existing.user_id === context.principal.userId,
      isApprover: canApproveQuotes(context.principal.role),
      // An agent is never the system actor. Expiry is the scheduler's job.
      isSystem: false,
    });

    await db
      .update(quotes)
      .set({ status: input.to })
      .where(and(eq(quotes.id, input.quoteId), eq(quotes.status, existing.status)));

    await db.insert(quoteEvents).values({
      quoteId: input.quoteId,
      type: transition.event,
      actor: 'agent',
      payload: { runId: context.runId, from: existing.status, to: input.to, reason: input.reason },
    });

    await writeAudit({
      actor: `agent:${context.runId}`,
      action: 'quote.transition',
      resource: `quote:${input.quoteId}`,
      before: { status: existing.status },
      after: { status: input.to, event: transition.event },
    });

    return {
      quoteId: input.quoteId,
      from: existing.status,
      to: input.to,
      event: transition.event,
    };
  },
};

/* ------------------------------------------------------------ sendQuoteEmail */

const sendEmailInput = z.object({ quoteId: z.string().uuid() }).strict();
const sendEmailOutput = z.object({
  quoteId: z.string(),
  sent: z.boolean(),
  heldForApproval: z.boolean(),
  detail: z.string(),
});

export const sendQuoteEmailTool: AgentTool<
  z.infer<typeof sendEmailInput>,
  z.infer<typeof sendEmailOutput>
> = {
  name: 'sendQuoteEmail',
  description:
    'Email a quote to its owner. A quote awaiting approval is held, not sent; ask a human to approve it first.',
  inputSchema: sendEmailInput,
  outputSchema: sendEmailOutput,
  // Sending is an outward-facing act, so it is staff-only even before the
  // state machine gets a say.
  allowedRoles: ['sales', 'admin'],
  jsonSchema: jsonSchemaOf({ quoteId: { type: 'string' } }, ['quoteId']),
  async execute(input, context) {
    const db = await getDatabase();
    const quote = firstRow<{ id: string; status: QuoteStatus; number: string }>(
      await db.execute(sql`
        select id, status::text as status, number from quotes where id = ${input.quoteId}::uuid limit 1
      `),
    );
    if (!quote) throw new ToolNotFound(`no quote ${input.quoteId}`);

    if (quote.status === 'pending_approval') {
      // Not an error: the correct outcome. The model is told plainly so it
      // reports the hold rather than retrying around it.
      await writeAudit({
        actor: `agent:${context.runId}`,
        action: 'quote.send.held',
        resource: `quote:${quote.id}`,
        before: { status: quote.status },
        after: { held: true },
      });
      return {
        quoteId: quote.id,
        sent: false,
        heldForApproval: true,
        detail: `quote ${quote.number} is awaiting human approval and was not sent`,
      };
    }

    if (quote.status !== 'sent' && quote.status !== 'viewed' && quote.status !== 'accepted') {
      return {
        quoteId: quote.id,
        sent: false,
        heldForApproval: false,
        detail: `quote ${quote.number} is ${quote.status}; only an approved quote is emailed`,
      };
    }

    await writeAudit({
      actor: `agent:${context.runId}`,
      action: 'quote.send',
      resource: `quote:${quote.id}`,
      before: null,
      after: { number: quote.number },
    });

    return {
      quoteId: quote.id,
      sent: true,
      heldForApproval: false,
      detail: `quote ${quote.number} emailed to its owner`,
    };
  },
};

export const ALL_TOOLS: readonly AgentTool<never, never>[] = [
  searchProductsTool,
  resolveCompatibilityTool,
  getPricingTool,
  createQuoteTool,
  updateQuoteStatusTool,
  sendQuoteEmailTool,
] as unknown as readonly AgentTool<never, never>[];

/** Tools this principal may use. The allowlist is built from this, once. */
export function toolsFor(role: string): AgentTool<never, never>[] {
  return ALL_TOOLS.filter((tool) => (tool.allowedRoles as readonly string[]).includes(role));
}

export async function quoteLineCount(quoteId: string): Promise<number> {
  const db = await getDatabase();
  const rows = await db
    .select({ id: quoteLineItems.id })
    .from(quoteLineItems)
    .where(eq(quoteLineItems.quoteId, quoteId));
  return rows.length;
}
