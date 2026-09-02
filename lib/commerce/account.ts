import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';

/**
 * What a signed-in buyer can see of their own history.
 *
 * The ownership check is in the query rather than applied to its results:
 * `where user_id = $viewer` cannot be forgotten by a later caller, whereas a
 * filter over a returned list can. Staff are not given a bypass here either —
 * this is the buyer's own view, and a staff view of somebody else's quotes is
 * a different screen with a different authorization story.
 */

export interface AccountQuote {
  id: string;
  number: string;
  status: string;
  subtotalCents: number;
  createdAt: Date;
  expiresAt: Date | null;
  lines: number;
}

export interface AccountOrder {
  id: string;
  number: string;
  status: string;
  paymentMethod: string;
  subtotalCents: number;
  poNumber: string | null;
  createdAt: Date;
  lines: number;
}

export async function quotesForUser(userId: string, limit = 20): Promise<AccountQuote[]> {
  const db = await getDatabase();
  const rows = toRows<{
    id: string;
    number: string;
    status: string;
    subtotal_cents: number;
    created_at: Date;
    expires_at: Date | null;
    lines: number;
  }>(
    await db.execute(sql`
      select q.id, q.number, q.status::text as status, q.subtotal_cents,
             q.created_at, q.expires_at,
             (select count(*) from quote_line_items l where l.quote_id = q.id)::int as lines
      from quotes q
      where q.user_id = ${userId}::uuid
      order by q.created_at desc
      limit ${limit}
    `),
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    subtotalCents: r.subtotal_cents,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lines: r.lines,
  }));
}

export async function ordersForUser(userId: string, limit = 20): Promise<AccountOrder[]> {
  const db = await getDatabase();
  const rows = toRows<{
    id: string;
    number: string;
    status: string;
    payment_method: string;
    subtotal_cents: number;
    po_number: string | null;
    created_at: Date;
    lines: number;
  }>(
    await db.execute(sql`
      select o.id, o.number, o.status::text as status,
             o.payment_method::text as payment_method, o.subtotal_cents,
             o.po_number, o.created_at,
             (select count(*) from order_items i where i.order_id = o.id)::int as lines
      from orders o
      where o.user_id = ${userId}::uuid
      order by o.created_at desc
      limit ${limit}
    `),
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    paymentMethod: r.payment_method,
    subtotalCents: r.subtotal_cents,
    poNumber: r.po_number,
    createdAt: r.created_at,
    lines: r.lines,
  }));
}

/** How a quote's state reads to the person who owns it, not to the system. */
export function quoteStatusCopy(status: string): string {
  switch (status) {
    case 'draft':
      return 'Drafted';
    case 'pending_approval':
      return 'Waiting on our approval';
    case 'sent':
      return 'Sent to you';
    case 'viewed':
      return 'Opened';
    case 'accepted':
      return 'Accepted';
    case 'converted':
      return 'Ordered';
    case 'expired':
      return 'Expired';
    case 'rejected':
      return 'Declined';
    default:
      return status;
  }
}
