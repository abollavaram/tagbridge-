import { createTransport } from 'nodemailer';
import { getDatabase } from '@/lib/db';
import { firstRow } from '@/lib/db/rows';
import { getEnv } from '@/lib/env';
import { sql } from 'drizzle-orm';
import { formatCents } from './pricing';

/**
 * Sending a quote.
 *
 * Split from the tool that calls it for one reason: `emailConfigured()` has to
 * be answerable without attempting a send, so the tool can report honestly
 * rather than claiming a delivery it did not make.
 *
 * Nodemailer was already a dependency and EMAIL_SERVER already in the env
 * contract — the transport simply was not wired to anything. When it is not
 * configured, nothing here pretends otherwise.
 */

export function emailConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.EMAIL_SERVER && env.EMAIL_FROM);
}

export interface QuoteEmailRequest {
  quoteId: string;
  quoteNumber: string;
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super('No mail transport is configured on this deployment.');
    this.name = 'MailNotConfiguredError';
  }
}

interface QuoteRow {
  number: string;
  subtotal_cents: number;
  expires_at: Date | null;
  email: string;
  name: string | null;
}

/**
 * Renders and sends the quote to the person who owns it.
 *
 * The recipient is read from the database rather than accepted as an argument:
 * a caller that could name the recipient is a caller that could send somebody
 * else's quote to an address of its choosing, and one of those callers is a
 * language model.
 */
export async function sendQuoteEmail(request: QuoteEmailRequest): Promise<void> {
  const env = getEnv();
  if (!env.EMAIL_SERVER || !env.EMAIL_FROM) throw new MailNotConfiguredError();

  const db = await getDatabase();
  const quote = firstRow<QuoteRow>(
    await db.execute(sql`
      select q.number, q.subtotal_cents, q.expires_at, u.email, u.name
      from quotes q join users u on u.id = q.user_id
      where q.id = ${request.quoteId}::uuid limit 1
    `),
  );
  if (!quote) throw new Error(`no quote ${request.quoteId}`);

  const expires = quote.expires_at
    ? new Date(quote.expires_at).toISOString().slice(0, 10)
    : 'no expiry recorded';

  const transport = createTransport(env.EMAIL_SERVER);
  await transport.sendMail({
    from: env.EMAIL_FROM,
    to: quote.email,
    subject: `Your TagBridge quote ${quote.number}`,
    text: [
      quote.name ? `Hello ${quote.name},` : 'Hello,',
      '',
      `Quote ${quote.number} is ready.`,
      `Total: ${formatCents(quote.subtotal_cents)}`,
      `Valid until: ${expires}`,
      '',
      'Every price on it was computed from the published volume breaks.',
    ].join('\n'),
  });
}
