import { desc, eq, sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import { auditLog } from '@/lib/db/schema';
import { redactObject } from './guardrails';

/**
 * The audit log.
 *
 * Append only, and enforced as such rather than merely intended: nothing in
 * this module updates or deletes, and the table is written through this one
 * function so there is a single place to look. Every entry is redacted on the
 * way in — an audit trail full of customer emails is a liability that grows
 * for as long as you keep it, and the actor and resource identify the row
 * without the PII.
 */

export interface AuditEntry {
  actor: string;
  action: string;
  resource: string;
  before: unknown;
  after: unknown;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const db = await getDatabase();
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    before: entry.before === null ? null : (redactObject(entry.before) as object),
    after: entry.after === null ? null : (redactObject(entry.after) as object),
  });
}

export async function auditFor(resource: string, limit = 50) {
  const db = await getDatabase();
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.resource, resource))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
}

export async function auditByActor(actorPrefix: string, limit = 100) {
  const db = await getDatabase();
  return toRows(
    await db.execute(sql`
      select actor, action, resource, before, after, created_at
      from audit_log
      where actor like ${`${actorPrefix}%`}
      order by created_at desc
      limit ${limit}
    `),
  );
}
