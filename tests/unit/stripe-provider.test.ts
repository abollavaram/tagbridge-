import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_PROVIDER_STATUSES,
  StripeHttpError,
  StripeProvider,
} from '@/lib/sync/provider';

/**
 * Drives the real StripeProvider against a stubbed fetch.
 *
 * The simulated provider cannot reach these paths: it returns everything in
 * one array and never fails, so neither the pagination bug nor the
 * swallow-every-error bug could show up in any existing test.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function subscription(id: string, status = 'active') {
  return {
    id,
    status,
    current_period_end: 1_800_000_000,
    items: { data: [{ price: { lookup_key: 'TB-OPCUA-4100-S' } }] },
    customer: { email: 'buyer@example.com' },
  };
}

describe('an outage is not a deletion (F-06)', () => {
  it('returns null on a genuine 404', async () => {
    globalThis.fetch = vi.fn(async () => respond(404, { error: { message: 'No such sub' } }));
    const provider = new StripeProvider('sk_test');
    await expect(provider.fetchSubscription('sub_missing')).resolves.toBeNull();
  });

  it('throws on a 500 rather than reporting the subscription gone', async () => {
    globalThis.fetch = vi.fn(async () => respond(500, { error: {} }));
    const provider = new StripeProvider('sk_test');
    // This used to return null, which the caller reads as authoritative and
    // settles — permanently discarding the update.
    await expect(provider.fetchSubscription('sub_1')).rejects.toBeInstanceOf(StripeHttpError);
  });

  it('throws on a 429', async () => {
    globalThis.fetch = vi.fn(async () => respond(429, {}));
    await expect(new StripeProvider('sk_test').fetchSubscription('sub_1')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('throws on a network failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(new StripeProvider('sk_test').fetchSubscription('sub_1')).rejects.toThrow();
  });

  it('returns the subscription on success', async () => {
    globalThis.fetch = vi.fn(async () => respond(200, subscription('sub_ok')));
    const found = await new StripeProvider('sk_test').fetchSubscription('sub_ok');
    expect(found?.id).toBe('sub_ok');
    expect(found?.variantSku).toBe('TB-OPCUA-4100-S');
  });
});

describe('every page, and every live status (F-07)', () => {
  it('follows has_more instead of stopping at the first 100', async () => {
    const pageOne = Array.from({ length: 100 }, (_, i) => subscription(`sub_a${i}`));
    const pageTwo = Array.from({ length: 40 }, (_, i) => subscription(`sub_b${i}`));

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return url.includes('starting_after')
        ? respond(200, { data: pageTwo, has_more: false })
        : respond(200, { data: pageOne, has_more: true });
    }) as typeof fetch;

    const all = await new StripeProvider('sk_test').listActiveSubscriptions();

    // 140, not 100. At 101 subscriptions the old version began reporting real
    // customers as drift, nightly and silently.
    expect(all).toHaveLength(140);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('starting_after=sub_a99');
  });

  it('stops when there is no more', async () => {
    const fetchMock = vi.fn(async () => respond(200, { data: [subscription('sub_1')], has_more: false }));
    globalThis.fetch = fetchMock as typeof fetch;
    await new StripeProvider('sk_test').listActiveSubscriptions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes trialing and past_due, which the reconciler counts as live', async () => {
    globalThis.fetch = vi.fn(async () =>
      respond(200, {
        data: [
          subscription('sub_active', 'active'),
          subscription('sub_trial', 'trialing'),
          subscription('sub_late', 'past_due'),
          subscription('sub_gone', 'canceled'),
        ],
        has_more: false,
      }),
    ) as typeof fetch;

    const all = await new StripeProvider('sk_test').listActiveSubscriptions();

    // The old query filtered on status=active at Stripe, so trialing and
    // past_due were absent from the remote side and flagged as drift.
    expect(all.map((s) => s.id).sort()).toEqual(['sub_active', 'sub_late', 'sub_trial']);
  });

  it('shares one definition of live with the reconciler', () => {
    expect([...LIVE_PROVIDER_STATUSES].sort()).toEqual(['active', 'past_due', 'trialing']);
  });

  it('stops on an empty page rather than looping', async () => {
    const fetchMock = vi.fn(async () => respond(200, { data: [], has_more: true }));
    globalThis.fetch = fetchMock as typeof fetch;
    await new StripeProvider('sk_test').listActiveSubscriptions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
