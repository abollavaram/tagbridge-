import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { processEvent, recordEvent } from '@/lib/sync/events';
import { getSubscriptionProvider } from '@/lib/sync/provider';
import { verifySignature } from '@/lib/sync/signature';
import { webhookSecret } from '@/lib/sync/secret';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The webhook endpoint.
 *
 * Order of operations is the whole design:
 *
 *   1. read the raw body, before anything can reformat it
 *   2. verify the signature against those exact bytes
 *   3. record the event, which is idempotent by database constraint
 *   4. process it, and return 200 either way
 *
 * Step 4 is the one that looks wrong and is not. A 5xx tells the provider to
 * redeliver, and redelivery is the right answer only when the event was never
 * durably stored. Once it is stored, this deployment owns the retry — with a
 * backoff it controls and a dead-letter queue an operator can see. Answering
 * 5xx after a successful record would hand the same event back on the
 * provider's schedule as well as ours, and the two retry loops would race.
 */

const eventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  created: z.number().int().positive(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

export async function POST(request: Request): Promise<NextResponse> {
  const log = requestLogger(requestIdFrom(request.headers));
  const raw = await request.text();

  const secret = webhookSecret();
  const verified = verifySignature(raw, request.headers.get('stripe-signature'), secret);
  if (!verified.ok) {
    // One generic message for every failure mode. Telling a caller whether the
    // timestamp or the digest was wrong helps an attacker and nobody else; the
    // specific reason goes to the log.
    log.warn({ reason: verified.reason }, 'webhook signature rejected');
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const parsed = eventSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const event = parsed.data;
  const outcome = await recordEvent({
    id: event.id,
    type: event.type,
    createdAt: new Date(event.created * 1000),
    payload: parsedBody,
  });

  if (outcome === 'duplicate') {
    log.info({ eventId: event.id, type: event.type }, 'webhook duplicate ignored');
    return NextResponse.json({ received: true, duplicate: true });
  }

  const result = await processEvent(event.id, getSubscriptionProvider());
  log.info({ eventId: event.id, type: event.type, status: result.status }, 'webhook processed');

  return NextResponse.json({ received: true, duplicate: false, status: result.status });
}

/** A GET is how a human checks the endpoint exists; it must never process anything. */
export function GET(): NextResponse {
  return NextResponse.json({
    endpoint: 'stripe webhooks',
    provider: getEnv().STRIPE_SECRET_KEY ? 'stripe' : 'simulated',
    signatureRequired: true,
  });
}
