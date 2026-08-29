import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { firstRow } = await import('@/lib/db/rows');
const { auditLog, quoteEvents, quoteLineItems, quotes } = await import('@/lib/db/schema');
const { handleMessage, MCP_PROTOCOL_VERSION, SERVER_INFO, SERVER_INSTRUCTIONS } = await import(
  '@/lib/mcp/server'
);

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;
let buyerCtx: { principal: { userId: string; email: string; role: 'buyer' }; runId: string };
let guestCtx: { principal: { userId: string; email: string; role: 'guest' }; runId: string };
let adminCtx: { principal: { userId: string; email: string; role: 'admin' }; runId: string };
let variantId: string;

function rpc(method: string, params?: unknown, id: number | string | null = 1) {
  return { jsonrpc: '2.0' as const, id, method, params };
}

beforeAll(async () => {
  db = await getDatabase();
  const buyer = firstRow<{ id: string; email: string }>(
    await db.execute(sql`select id, email from users where role = 'buyer' limit 1`),
  )!;
  const admin = firstRow<{ id: string; email: string }>(
    await db.execute(sql`select id, email from users where role = 'admin' limit 1`),
  )!;
  buyerCtx = {
    principal: { userId: buyer.id, email: buyer.email, role: 'buyer' },
    runId: 'run-buyer',
  };
  adminCtx = {
    principal: { userId: admin.id, email: admin.email, role: 'admin' },
    runId: 'run-admin',
  };
  guestCtx = {
    principal: { userId: buyer.id, email: '', role: 'guest' },
    runId: 'run-guest',
  };
  variantId = firstRow<{ id: string }>(
    await db.execute(sql`select id from product_variants order by sku limit 1`),
  )!.id;
}, 180_000);

beforeEach(async () => {
  await db.delete(quoteEvents);
  await db.delete(quoteLineItems);
  await db.delete(quotes);
  await db.delete(auditLog);
});

describe('the handshake', () => {
  it('reports the protocol version and server identity', async () => {
    const response = await handleMessage(rpc('initialize'), buyerCtx);
    expect(response?.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
    });
  });

  it('declares only capabilities that are implemented', async () => {
    const response = await handleMessage(rpc('initialize'), buyerCtx);
    const capabilities = (response?.result as { capabilities: Record<string, unknown> })
      .capabilities;
    expect(Object.keys(capabilities)).toEqual(['tools']);
  });

  it('tells the client the price rule up front', async () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/never set a price/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/human for approval/i);
  });

  it('answers ping', async () => {
    expect((await handleMessage(rpc('ping'), buyerCtx))?.result).toEqual({});
  });

  it('returns nothing for the initialized notification', async () => {
    const notification = { jsonrpc: '2.0' as const, method: 'notifications/initialized' };
    expect(await handleMessage(notification, buyerCtx)).toBeNull();
  });

  it('rejects a message that is not JSON-RPC 2.0', async () => {
    expect((await handleMessage({ method: 'tools/list' }, buyerCtx))?.error?.code).toBe(-32600);
  });

  it('reports an unknown method rather than failing silently', async () => {
    expect((await handleMessage(rpc('tools/enumerate'), buyerCtx))?.error?.code).toBe(-32601);
  });
});

describe('tools/list is scoped to the caller', () => {
  it('gives a buyer the quoting tools', async () => {
    const response = await handleMessage(rpc('tools/list'), buyerCtx);
    const names = (response?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain('searchProducts');
    expect(names).toContain('createQuote');
  });

  it('does not show a buyer the tools they cannot call', async () => {
    const response = await handleMessage(rpc('tools/list'), buyerCtx);
    const names = (response?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).not.toContain('sendQuoteEmail');
  });

  it('gives a guest only catalogue tools', async () => {
    const response = await handleMessage(rpc('tools/list'), guestCtx);
    const names = (response?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain('searchProducts');
    expect(names).toContain('resolveCompatibility');
    expect(names).not.toContain('createQuote');
  });

  it('gives an admin everything', async () => {
    const response = await handleMessage(rpc('tools/list'), adminCtx);
    const names = (response?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toContain('sendQuoteEmail');
  });

  it('ships a JSON Schema with every tool', async () => {
    const response = await handleMessage(rpc('tools/list'), buyerCtx);
    const tools = (response?.result as { tools: { inputSchema: { type: string } }[] }).tools;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
  });
});

describe('tools/call', () => {
  it('runs a search and returns the products', async () => {
    const response = await handleMessage(
      rpc('tools/call', { name: 'searchProducts', arguments: { query: 'OPC UA server' } }),
      buyerCtx,
    );
    const result = response?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text).hits.length).toBeGreaterThan(0);
  });

  it('resolves compatibility deterministically', async () => {
    const response = await handleMessage(
      rpc('tools/call', {
        name: 'resolveCompatibility',
        arguments: {
          sourceDevice: 'allen-bradley',
          destinationSystem: 'sql-server',
          tagCount: 5000,
        },
      }),
      buyerCtx,
    );
    const result = response?.result as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text).bundle.length).toBeGreaterThan(0);
  });

  it('refuses a price supplied by the client', async () => {
    const response = await handleMessage(
      rpc('tools/call', {
        name: 'createQuote',
        arguments: { lines: [{ variantId, qty: 1, unitPriceCents: 1 }] },
      }),
      buyerCtx,
    );
    const result = response?.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/computed by the server/i);
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('refuses a tool the caller’s role does not have', async () => {
    const response = await handleMessage(
      rpc('tools/call', { name: 'createQuote', arguments: { lines: [{ variantId, qty: 1 }] } }),
      guestCtx,
    );
    expect((response?.result as { isError: boolean }).isError).toBe(true);
    expect(await db.select().from(quotes)).toHaveLength(0);
  });

  it('refuses a tool that does not exist', async () => {
    const response = await handleMessage(
      rpc('tools/call', { name: 'dropDatabase', arguments: {} }),
      adminCtx,
    );
    expect((response?.result as { isError: boolean }).isError).toBe(true);
  });

  it('reports a schema failure as a tool error, not a transport error', async () => {
    const response = await handleMessage(
      rpc('tools/call', { name: 'getPricing', arguments: { variantId: 'nope', qty: 0 } }),
      buyerCtx,
    );
    // A tool error the model can read and correct, rather than an RPC error
    // it would retry unchanged.
    expect(response?.error).toBeUndefined();
    expect((response?.result as { isError: boolean }).isError).toBe(true);
  });

  it('requires params.name', async () => {
    const response = await handleMessage(rpc('tools/call', { arguments: {} }), buyerCtx);
    expect(response?.error?.code).toBe(-32602);
  });

  it('drafts a quote that lands in pending_approval', async () => {
    const response = await handleMessage(
      rpc('tools/call', { name: 'createQuote', arguments: { lines: [{ variantId, qty: 2 }] } }),
      buyerCtx,
    );
    const result = response?.result as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeUndefined();
    const quote = JSON.parse(result.content[0]!.text);
    expect(quote.requiresApproval).toBe(true);
    expect(quote.subtotalCents).toBeGreaterThan(0);
  });

  it('prices the quote from the tiers, not from anything the client sent', async () => {
    await handleMessage(
      rpc('tools/call', { name: 'createQuote', arguments: { lines: [{ variantId, qty: 2 }] } }),
      buyerCtx,
    );
    const lines = await db.select().from(quoteLineItems);
    expect(lines[0]!.unitPriceCents).toBeGreaterThan(0);
  });

  it('writes an audit entry naming the MCP run', async () => {
    await handleMessage(
      rpc('tools/call', { name: 'createQuote', arguments: { lines: [{ variantId, qty: 1 }] } }),
      buyerCtx,
    );
    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.actor === `agent:${buyerCtx.runId}`)).toBe(true);
  });
});
