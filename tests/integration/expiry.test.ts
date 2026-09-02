import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { firstRow } = await import('@/lib/db/rows');
const { auditLog, quoteEvents, quoteLineItems, quotes } = await import('@/lib/db/schema');
const { expireOverdueQuotes } = await import('@/lib/commerce/expiry');

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;
let userId: string;

const PAST = new Date('2026-01-01T00:00:00Z');
const FUTURE = new Date('2099-01-01T00:00:00Z');

async function quoteWith(status: string, expiresAt: Date | null, number: string) {
  const db2 = await getDatabase();
  const rows = await db2.execute<{ id: string }>(sql`
    insert into quotes (number, user_id, status, subtotal_cents, expires_at)
    values (${number}, ${userId}::uuid, ${status}::quote_status, 1000, ${expiresAt})
    returning id
  `);
  return firstRow<{ id: string }>(rows)!.id;
}

async function statusOf(id: string): Promise<string> {
  const row = firstRow<{ status: string }>(
    await db.execute(sql`select status::text as status from quotes where id = ${id}::uuid`),
  );
  return row!.status;
}

beforeAll(async () => {
  db = await getDatabase();
  userId = firstRow<{ id: string }>(
    await db.execute(sql`select id from users where role = 'buyer' limit 1`),
  )!.id;
}, 180_000);

beforeEach(async () => {
  await db.delete(quoteEvents);
  await db.delete(quoteLineItems);
  await db.delete(quotes);
  await db.delete(auditLog);
});

describe('quotes actually expire now (F-10)', () => {
  it('expires an overdue sent quote', async () => {
    const id = await quoteWith('sent', PAST, 'Q-EXP-1');
    const report = await expireOverdueQuotes();
    expect(report.expired).toBe(1);
    expect(await statusOf(id)).toBe('expired');
  });

  it('expires viewed and accepted quotes too', async () => {
    const viewed = await quoteWith('viewed', PAST, 'Q-EXP-2');
    const accepted = await quoteWith('accepted', PAST, 'Q-EXP-3');
    await expireOverdueQuotes();
    expect(await statusOf(viewed)).toBe('expired');
    expect(await statusOf(accepted)).toBe('expired');
  });

  it('leaves a quote that has not run out', async () => {
    const id = await quoteWith('sent', FUTURE, 'Q-EXP-4');
    const report = await expireOverdueQuotes();
    expect(report.expired).toBe(0);
    expect(await statusOf(id)).toBe('sent');
  });

  it('leaves a draft alone — the state machine has no draft to expired edge', async () => {
    const id = await quoteWith('draft', PAST, 'Q-EXP-5');
    await expireOverdueQuotes();
    expect(await statusOf(id)).toBe('draft');
  });

  it('leaves a terminal quote alone', async () => {
    const id = await quoteWith('rejected', PAST, 'Q-EXP-6');
    await expireOverdueQuotes();
    expect(await statusOf(id)).toBe('rejected');
  });

  it('leaves a quote with no expiry recorded', async () => {
    const id = await quoteWith('sent', null, 'Q-EXP-7');
    await expireOverdueQuotes();
    expect(await statusOf(id)).toBe('sent');
  });

  it('writes the state machine’s own event, not a bulk update', async () => {
    await quoteWith('sent', PAST, 'Q-EXP-8');
    await expireOverdueQuotes();
    const events = await db.select().from(quoteEvents);
    expect(events.map((e) => e.type)).toContain('quote.expired');
    expect(events[0]!.actor).toBe('system');
  });

  it('records the run in the audit log', async () => {
    await quoteWith('sent', PAST, 'Q-EXP-9');
    await expireOverdueQuotes();
    const entries = await db.select().from(auditLog);
    expect(entries.some((e) => e.action === 'quotes.expired')).toBe(true);
  });

  it('is safe to run twice', async () => {
    await quoteWith('sent', PAST, 'Q-EXP-10');
    const first = await expireOverdueQuotes();
    const second = await expireOverdueQuotes();
    expect(first.expired).toBe(1);
    expect(second.expired).toBe(0);
  });

  it('reports how much it considered, so an empty run is distinguishable', async () => {
    const report = await expireOverdueQuotes();
    expect(report.considered).toBe(0);
    expect(report.ranAt).toBeInstanceOf(Date);
  });
});
