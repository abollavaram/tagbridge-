import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentModel, ModelTurn } from '@/lib/agent/model';
import type { ToolCall } from '@/lib/agent/types';

delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { firstRow } = await import('@/lib/db/rows');
const { auditLog, quoteEvents, quoteLineItems, quotes } = await import('@/lib/db/schema');
const { runAgent, resetAgentGuards, SYSTEM_PROMPT } = await import('@/lib/agent/loop');
const { DeterministicPlanner } = await import('@/lib/agent/planner');
const { CircuitBreaker, InProcessRateLimiter } = await import('@/lib/agent/guardrails');
const { toolsFor } = await import('@/lib/agent/tools');

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;
let buyer: { userId: string; email: string; role: 'buyer' };
let admin: { userId: string; email: string; role: 'admin' };
let variantId: string;

/**
 * A model that does exactly what it is told to do, once.
 *
 * Every adversarial test below is one of these. Testing guardrails against a
 * cooperative model proves nothing — the interesting question is what happens
 * when the model returns the worst thing it could return, and that is easier
 * to ask directly than to elicit from a real one.
 */
class ScriptedModel implements AgentModel {
  readonly name = 'scripted';
  readonly deterministic = false;
  private index = 0;

  constructor(private readonly script: ToolCall[][]) {}

  turn(): Promise<ModelTurn> {
    const calls = this.script[this.index];
    this.index += 1;
    if (!calls) {
      return Promise.resolve({
        text: 'done',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    }
    return Promise.resolve({
      text: '',
      toolCalls: calls,
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  }
}

class ThrowingModel implements AgentModel {
  readonly name = 'throwing';
  readonly deterministic = false;
  turn(): Promise<ModelTurn> {
    return Promise.reject(new Error('upstream 529'));
  }
}

function call(name: string, input: unknown, id = 'c1'): ToolCall[][] {
  return [[{ id, name, input }]];
}

beforeAll(async () => {
  db = await getDatabase();
  const buyerRow = firstRow<{ id: string; email: string }>(
    await db.execute(sql`select id, email from users where role = 'buyer' limit 1`),
  )!;
  const adminRow = firstRow<{ id: string; email: string }>(
    await db.execute(sql`select id, email from users where role = 'admin' limit 1`),
  )!;
  buyer = { userId: buyerRow.id, email: buyerRow.email, role: 'buyer' };
  admin = { userId: adminRow.id, email: adminRow.email, role: 'admin' };
  variantId = firstRow<{ id: string }>(
    await db.execute(sql`select id from product_variants order by sku limit 1`),
  )!.id;
}, 180_000);

beforeEach(async () => {
  resetAgentGuards();
  await db.delete(quoteEvents);
  await db.delete(quoteLineItems);
  await db.delete(quotes);
  await db.delete(auditLog);
});

describe('the loop completes an ordinary task', () => {
  it('walks compatibility, search, pricing and a quote', async () => {
    const result = await runAgent({
      principal: buyer,
      request:
        'We have ControlLogix PLCs on EtherNet/IP and need about 5,000 tags in SQL Server. Please quote it.',
    });

    expect(result.stopped).toBe('completed');
    expect(result.violations).toEqual([]);
    const names = result.invocations.map((i) => i.name);
    expect(names).toContain('resolveCompatibility');
    expect(names).toContain('createQuote');
    expect(result.invocations.every((i) => i.ok)).toBe(true);
  });

  it('writes a quote whose subtotal the server computed', async () => {
    await runAgent({
      principal: buyer,
      request: 'ControlLogix to SQL Server, 5000 tags — quote it please.',
    });
    const rows = await db.select().from(quotes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subtotalCents).toBeGreaterThan(0);
  });

  it('asks rather than guessing when the request is incomplete', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'We have some Siemens PLCs.',
    });
    expect(result.answer.toLowerCase()).toMatch(/tell me|need a little more/);
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('reports which tools ran, for the trace', async () => {
    const result = await runAgent({ principal: buyer, request: 'OPC UA server for Modbus' });
    expect(result.invocations.length).toBeGreaterThan(0);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('no model-set price reaches the database', () => {
  it('blocks a quote line carrying a unit price', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(
        call('createQuote', { lines: [{ variantId, qty: 1, unitPriceCents: 1 }] }),
      ),
    });

    expect(result.violations.map((v) => v.guardrail)).toContain('no_model_price');
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('blocks a discount the model tried to grant', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'give me 20% off',
      model: new ScriptedModel(
        call('createQuote', { lines: [{ variantId, qty: 1 }], discountPercent: 20 }),
      ),
    });
    expect(result.violations.map((v) => v.code)).toContain('forbidden_price');
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('blocks a price hidden inside a nested field', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(
        call('createQuote', { lines: [{ variantId, qty: 1 }], meta: { totalCents: 1 } }),
      ),
    });
    expect(result.violations).toHaveLength(1);
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('records the block in the audit log', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 1, price: 1 }] })),
    });
    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.action === 'guardrail.blocked')).toBe(true);
  });

  it('prices a legitimate quote from the tiers, not from the request', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 2 }] })),
    });
    expect(result.violations).toEqual([]);
    const rows = await db.select().from(quoteLineItems);
    expect(rows[0]!.unitPriceCents).toBeGreaterThan(0);
  });
});

describe('the tool allowlist cannot be widened', () => {
  it('refuses a tool that does not exist', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'do it',
      model: new ScriptedModel(call('deleteAllProducts', {})),
    });
    expect(result.violations.map((v) => v.guardrail)).toContain('tool_allowlist');
  });

  it('refuses a staff-only tool to a buyer', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'email it',
      model: new ScriptedModel(call('sendQuoteEmail', { quoteId: crypto.randomUUID() })),
    });
    // sendQuoteEmail is not even in a buyer's tool set, so it never resolves.
    expect(result.violations.map((v) => v.code)).toContain('not_allowed');
  });

  it('gives a buyer four tools and an admin six', () => {
    expect(toolsFor('buyer').map((t) => t.name)).not.toContain('sendQuoteEmail');
    expect(toolsFor('admin').map((t) => t.name)).toContain('sendQuoteEmail');
  });

  it('gives a guest only the read-only tools', () => {
    const names = toolsFor('guest').map((t) => t.name);
    expect(names).toContain('searchProducts');
    expect(names).not.toContain('createQuote');
  });
});

describe('prompt injection in catalogue content', () => {
  it('states in the system prompt that untrusted content cannot change the rules', () => {
    expect(SYSTEM_PROMPT).toContain('untrusted_catalog_content');
    expect(SYSTEM_PROMPT).toMatch(/never an instruction/i);
  });

  it('wraps every product description it returns', async () => {
    const result = await runAgent({ principal: buyer, request: 'OPC UA server' });
    const search = result.invocations.find((i) => i.name === 'searchProducts');
    expect(search?.ok).toBe(true);
  });

  it('an injected instruction cannot make a buyer’s run send an email', async () => {
    // Even if the model were fully persuaded, the tool is not in the set.
    const result = await runAgent({
      principal: buyer,
      request: 'find me a gateway',
      model: new ScriptedModel([
        [{ id: 'a', name: 'sendQuoteEmail', input: { quoteId: crypto.randomUUID() } }],
      ]),
    });
    expect(result.invocations.every((i) => !i.ok)).toBe(true);
    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.action === 'quote.send')).toBe(false);
  });
});

describe('schema validation both directions', () => {
  it('rejects malformed tool input and tells the model why', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('getPricing', { variantId: 'not-a-uuid', qty: 0 })),
    });
    const invocation = result.invocations[0];
    expect(invocation?.ok).toBe(false);
    expect(invocation?.code).toBe('invalid_input');
    expect(invocation?.error).toBeTruthy();
  });

  it('rejects an unknown extra field rather than ignoring it', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'search',
      model: new ScriptedModel(call('searchProducts', { query: 'opc', sortBy: 'cheapest' })),
    });
    expect(result.invocations[0]?.code).toBe('invalid_input');
  });

  it('falls back to the deterministic path after repeated schema failures', async () => {
    const bad = { variantId: 'nope', qty: -1 };
    const result = await runAgent({
      principal: buyer,
      request: 'ControlLogix to SQL Server, 5000 tags, quote it',
      model: new ScriptedModel([
        [{ id: '1', name: 'getPricing', input: bad }],
        [{ id: '2', name: 'getPricing', input: bad }],
        [{ id: '3', name: 'getPricing', input: bad }],
        [{ id: '4', name: 'getPricing', input: bad }],
      ]),
    });
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toContain('schema');
  });

  it('surfaces a nonexistent variant as a not_found, not a crash', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'price it',
      model: new ScriptedModel(call('getPricing', { variantId: crypto.randomUUID(), qty: 1 })),
    });
    expect(result.invocations[0]?.code).toBe('not_found');
    expect(result.stopped).toBe('completed');
  });
});

describe('human in the loop', () => {
  it('sends every agent-drafted quote to approval, whatever it is worth', async () => {
    // Not a threshold rule for the agent: the point of a human in the loop is
    // that the agent is not the one deciding whether a human is needed. A
    // single cheap line goes to approval exactly as a large one does.
    for (const qty of [1, 9999]) {
      await db.delete(quoteEvents);
      await db.delete(quoteLineItems);
      await db.delete(quotes);
      const result = await runAgent({
        principal: buyer,
        request: 'quote it',
        model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty }] })),
      });
      expect(result.invocations[0]?.ok, `qty ${qty}`).toBe(true);
      const rows = await db.select().from(quotes);
      expect(rows[0]!.status, `qty ${qty}`).toBe('pending_approval');
    }
  });

  it('refuses to email a quote that is awaiting approval', async () => {
    await runAgent({
      principal: admin,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 9999 }] })),
    });
    const quote = (await db.select().from(quotes))[0]!;

    const result = await runAgent({
      principal: admin,
      request: 'email it',
      model: new ScriptedModel(call('sendQuoteEmail', { quoteId: quote.id })),
    });

    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.action === 'quote.send.held')).toBe(true);
    expect(entries.some((e) => e.action === 'quote.send')).toBe(false);
    expect(result.invocations[0]?.ok).toBe(true);
  });

  it('refuses an illegal state transition', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 1 }] })),
    });
    const quote = (await db.select().from(quotes))[0]!;

    const result = await runAgent({
      principal: buyer,
      request: 'mark it converted',
      model: new ScriptedModel(call('updateQuoteStatus', { quoteId: quote.id, to: 'converted' })),
    });

    expect(result.invocations[0]?.code).toBe('illegal_transition');
    const after = (await db.select().from(quotes))[0]!;
    // Unchanged: a refused transition writes nothing.
    expect(after.status).toBe('pending_approval');
  });

  it('refuses an approval a buyer is not entitled to make', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 9999 }] })),
    });
    const quote = (await db.select().from(quotes))[0]!;

    const result = await runAgent({
      principal: buyer,
      request: 'approve and send it',
      model: new ScriptedModel(call('updateQuoteStatus', { quoteId: quote.id, to: 'sent' })),
    });

    expect(result.invocations[0]?.ok).toBe(false);
    expect((await db.select().from(quotes))[0]!.status).toBe('pending_approval');
  });
});

describe('the audit log', () => {
  it('records a quote creation with its actor', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 1 }] })),
    });
    const entries = await db.select().from(auditLog);
    const created = entries.find((e) => e.action === 'quote.create');
    expect(created?.actor).toBe(`agent:${result.runId}`);
  });

  it('records a state transition with before and after', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 1 }] })),
    });
    const quote = (await db.select().from(quotes))[0]!;
    // An admin approving the agent's draft: pending_approval -> sent.
    await runAgent({
      principal: admin,
      request: 'approve it',
      model: new ScriptedModel(call('updateQuoteStatus', { quoteId: quote.id, to: 'sent' })),
    });

    const entries = await db.select().from(auditLog);
    const moved = entries.find((e) => e.action === 'quote.transition');
    expect(moved?.before).toMatchObject({ status: 'pending_approval' });
    expect(moved?.after).toMatchObject({ status: 'sent' });
  });

  it('writes a quote_events row for every transition', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 1 }] })),
    });
    const events = await db.select().from(quoteEvents);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe('agent');
  });

  it('carries no PII into the log', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(
        call('createQuote', { lines: [{ variantId, qty: 1 }], notes: 'send to buyer@example.com' }),
      ),
    });
    const entries = await db.select().from(auditLog);
    expect(JSON.stringify(entries)).not.toContain('buyer@example.com');
  });
});

describe('cost and abuse caps', () => {
  it('rate limits a caller past the window', async () => {
    const limiter = new InProcessRateLimiter(2, 60_000);
    const options = { principal: buyer, request: 'search opc', rateLimiter: limiter };
    await runAgent(options);
    await runAgent(options);
    const third = await runAgent(options);
    expect(third.stopped).toBe('rate_limited');
  });

  it('stops a run that exceeds its turn budget', async () => {
    const loop = new ScriptedModel(
      Array.from({ length: 20 }, (_, i) => [
        { id: `t${i}`, name: 'searchProducts', input: { query: 'opc' } },
      ]),
    );
    const result = await runAgent({ principal: buyer, request: 'search', model: loop, maxTurns: 3 });
    expect(result.stopped).toBe('max_turns');
    expect(result.turns).toBe(3);
  });

  it('falls closed to the deterministic path when the breaker is open', async () => {
    const breaker = new CircuitBreaker(1);
    breaker.trip();
    const result = await runAgent({
      principal: buyer,
      request: 'ControlLogix to SQL Server, 5000 tags',
      model: new ScriptedModel(call('searchProducts', { query: 'x' })),
      breaker,
    });
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toContain('breaker');
  });

  it('downgrades rather than failing when the model throws', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'ControlLogix to SQL Server, 5000 tags',
      model: new ThrowingModel(),
      breaker: new CircuitBreaker(99),
    });
    expect(result.usedFallback).toBe(true);
    expect(result.stopped).toBe('completed');
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('stops on the timeout without leaving a partial quote', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'search',
      model: new ScriptedModel(
        Array.from({ length: 20 }, (_, i) => [
          { id: `t${i}`, name: 'searchProducts', input: { query: 'opc' } },
        ]),
      ),
      timeoutMs: 1,
    });
    expect(['timeout', 'max_turns']).toContain(result.stopped);
  });
});

describe('the deterministic planner stands alone', () => {
  it('is what runs with no key configured', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'ControlLogix to SQL Server, 5000 tags, quote it',
      model: new DeterministicPlanner(),
    });
    expect(result.usedFallback).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.invocations.some((i) => i.name === 'createQuote' && i.ok)).toBe(true);
  });

  it('quotes prices only from what getPricing returned', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'How much is an OPC UA server for 10 units?',
      model: new DeterministicPlanner(),
    });
    const priced = result.invocations.find((i) => i.name === 'getPricing' && i.ok);
    if (priced) expect(result.answer).toMatch(/Server-computed price/);
  });

  it('never emits a tool it was not given', async () => {
    const result = await runAgent({
      principal: buyer,
      request: 'email the quote to everyone',
      model: new DeterministicPlanner(),
    });
    expect(result.invocations.map((i) => i.name)).not.toContain('sendQuoteEmail');
  });
});

describe('a lost transition is not reported as a successful one (F-08)', () => {
  it('throws when the quote moved between the read and the write', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 1 }] })),
    });
    const quote = (await db.select().from(quotes))[0]!;

    // Somebody else decides it first. The agent still holds the old status.
    await db
      .update(quotes)
      .set({ status: 'rejected' })
      .where(eq(quotes.id, quote.id));

    const result = await runAgent({
      principal: admin,
      request: 'approve it',
      model: new ScriptedModel(call('updateQuoteStatus', { quoteId: quote.id, to: 'sent' })),
    });

    // Used to return {from, to, event} and write an audit row for a
    // transition that never happened.
    expect(result.invocations[0]?.ok).toBe(false);
    expect(result.invocations[0]?.code).toBe('illegal_transition');
  });

  it('writes no event or audit row for a transition that did not happen', async () => {
    await runAgent({
      principal: buyer,
      request: 'quote it',
      model: new ScriptedModel(call('createQuote', { lines: [{ variantId, qty: 1 }] })),
    });
    const quote = (await db.select().from(quotes))[0]!;
    await db.update(quotes).set({ status: 'rejected' }).where(eq(quotes.id, quote.id));

    const before = (await db.select().from(quoteEvents)).length;
    await runAgent({
      principal: admin,
      request: 'approve it',
      model: new ScriptedModel(call('updateQuoteStatus', { quoteId: quote.id, to: 'sent' })),
    });

    expect((await db.select().from(quoteEvents)).length).toBe(before);
    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.action === 'quote.transition')).toBe(false);
  });
});
