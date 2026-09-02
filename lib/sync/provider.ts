import { getEnv } from '@/lib/env';

/**
 * The subscription provider seam.
 *
 * The rule this whole module exists to enforce is the spec's: a webhook is a
 * trigger, never truth. The payload says *something changed*; it does not say
 * what the state is now. Two events can arrive out of order, a payload can be
 * replayed, and a malicious sender who somehow got past the signature check
 * could claim anything. So the handler ignores the payload's state entirely
 * and asks the provider what the subscription actually looks like.
 *
 * `SubscriptionProvider` is that question. `StripeProvider` asks Stripe.
 * `SimulatedProvider` holds the state in process, and is what a clean clone
 * with no credentials runs against — the same code path, the same re-read,
 * with a provider whose state can be driven from a test or the admin
 * dashboard's "break sync" button.
 */

export type ProviderSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete';

export interface ProviderSubscription {
  id: string;
  status: ProviderSubscriptionStatus;
  currentPeriodEnd: Date | null;
  /** Variant SKU the subscription is for. Maps onto product_variants.sku. */
  variantSku: string;
  customerEmail: string;
  /** Provider-side last-modified time, used to resolve out-of-order events. */
  updatedAt: Date;
}

export interface SubscriptionProvider {
  readonly name: string;
  /** The authoritative read. Returns null when the provider has no such subscription. */
  fetchSubscription(id: string): Promise<ProviderSubscription | null>;
  /** Every subscription the provider considers live, for reconciliation. */
  listActiveSubscriptions(): Promise<ProviderSubscription[]>;
}

/**
 * An in-process provider that is genuinely authoritative for this deployment.
 *
 * Not a mock in the usual sense: nothing stubs it out per test. It holds real
 * state, the handler re-reads from it exactly as it would from Stripe, and
 * driving it out of step with the database is what produces the drift the
 * reconciler is supposed to find.
 */
export class SimulatedProvider implements SubscriptionProvider {
  readonly name = 'simulated';
  private readonly store = new Map<string, ProviderSubscription>();

  upsert(subscription: ProviderSubscription): void {
    this.store.set(subscription.id, { ...subscription });
  }

  /** Mutates provider-side state without telling the app — this is how drift starts. */
  mutateSilently(id: string, patch: Partial<ProviderSubscription>): boolean {
    const existing = this.store.get(id);
    if (!existing) return false;
    this.store.set(id, { ...existing, ...patch, updatedAt: new Date() });
    return true;
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  fetchSubscription(id: string): Promise<ProviderSubscription | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? { ...found } : null);
  }

  listActiveSubscriptions(): Promise<ProviderSubscription[]> {
    const live = [...this.store.values()]
      .filter((s) => LIVE_PROVIDER_STATUSES.has(s.status))
      .map((s) => ({ ...s }));
    return Promise.resolve(live);
  }
}

interface StripeSubscriptionPayload {
  id: string;
  status: string;
  current_period_end?: number | null;
  items?: { data?: { price?: { lookup_key?: string | null } | null }[] };
  customer?: { email?: string | null } | string | null;
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'incomplete',
]);

/**
 * Maps a Stripe status onto ours.
 *
 * `incomplete_expired` and `paused` have no row in our enum. They are mapped
 * rather than dropped, because an unmapped status silently becoming `active`
 * would be a billing bug, and throwing would dead-letter an event that is
 * perfectly well-formed.
 */
export function mapStripeStatus(status: string): ProviderSubscriptionStatus {
  if (KNOWN_STATUSES.has(status)) return status as ProviderSubscriptionStatus;
  if (status === 'incomplete_expired') return 'incomplete';
  if (status === 'paused') return 'past_due';
  return 'canceled';
}

/** Carries the status so a 404 can be told apart from an outage. */
export class StripeHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
  ) {
    super(`stripe ${path} responded ${status}`);
    this.name = 'StripeHttpError';
  }
}

/**
 * What counts as live, shared by the provider and the reconciler.
 *
 * Defined once because the two disagreeing is what produced phantom drift:
 * the provider filtered on `active`, the reconciler counted three statuses.
 */
export const LIVE_PROVIDER_STATUSES: ReadonlySet<ProviderSubscriptionStatus> = new Set([
  'active',
  'trialing',
  'past_due',
]);

export class StripeProvider implements SubscriptionProvider {
  readonly name = 'stripe';

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = 'https://api.stripe.com/v1',
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Stripe-Version': '2025-08-27.basil',
      },
    });
    if (!response.ok) {
      throw new StripeHttpError(path, response.status);
    }
    return (await response.json()) as T;
  }

  private static toSubscription(raw: StripeSubscriptionPayload): ProviderSubscription {
    const customer = raw.customer;
    return {
      id: raw.id,
      status: mapStripeStatus(raw.status),
      currentPeriodEnd: raw.current_period_end
        ? new Date(raw.current_period_end * 1000)
        : null,
      // The price's lookup key carries our variant SKU. Stripe's own product
      // ids mean nothing to this catalogue.
      variantSku: raw.items?.data?.[0]?.price?.lookup_key ?? '',
      customerEmail:
        typeof customer === 'object' && customer !== null ? (customer.email ?? '') : '',
      updatedAt: new Date(),
    };
  }

  /**
   * Only a 404 means "no such subscription".
   *
   * This used to be `try { … } catch { return null }`, which reported a 500, a
   * 429, a timeout and a DNS failure identically to a genuine 404. Downstream
   * that null is read as authoritative — "the provider does not have it, not
   * retryable" — and the event is settled. So a transient blip silently and
   * permanently discarded a subscription update: no retry, no dead letter,
   * nothing on the drift dashboard. Exactly the missing-signal failure this
   * whole phase exists to defend against.
   *
   * Everything that is not a 404 now throws, so the backoff and dead-letter
   * machinery that was already built and tested finally gets reached.
   */
  async fetchSubscription(id: string): Promise<ProviderSubscription | null> {
    try {
      const raw = await this.get<StripeSubscriptionPayload>(
        `/subscriptions/${encodeURIComponent(id)}?expand[]=customer`,
      );
      return StripeProvider.toSubscription(raw);
    } catch (error) {
      if (error instanceof StripeHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Every live subscription, across every page.
   *
   * Two bugs lived in the three lines this replaces. It read one page of 100
   * and never looked at `has_more`, so at 101 subscriptions the reconciler
   * began reporting real customers as drift, nightly and silently. And it
   * asked Stripe for `status=active` while the reconciler treats
   * active, trialing and past_due as live — so every trialing and past-due
   * subscription was absent from the remote side and flagged as a discrepancy
   * that was not one. The one job of this call is to be trustworthy.
   */
  async listActiveSubscriptions(): Promise<ProviderSubscription[]> {
    const all: ProviderSubscription[] = [];
    let startingAfter: string | undefined;

    // A guard, not a limit: at 100 per page this is 10,000 subscriptions, and
    // an unbounded loop against a paginating API is its own outage.
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: '100', 'expand[]': 'data.customer' });
      if (startingAfter) query.set('starting_after', startingAfter);

      const result = await this.get<{
        data: StripeSubscriptionPayload[];
        has_more?: boolean;
      }>(`/subscriptions?${query.toString()}`);

      for (const raw of result.data) {
        const subscription = StripeProvider.toSubscription(raw);
        // Filtered here rather than in the query: Stripe's status filter takes
        // one value, and the set the reconciler calls live has three.
        if (LIVE_PROVIDER_STATUSES.has(subscription.status)) all.push(subscription);
      }

      if (!result.has_more || result.data.length === 0) break;
      startingAfter = result.data[result.data.length - 1]?.id;
      if (!startingAfter) break;
    }

    return all;
  }
}

let simulated: SimulatedProvider | null = null;

/** The process-wide simulated provider, so route handlers and the dashboard share one. */
export function simulatedProvider(): SimulatedProvider {
  simulated ??= new SimulatedProvider();
  return simulated;
}

export function getSubscriptionProvider(): SubscriptionProvider {
  const key = getEnv().STRIPE_SECRET_KEY;
  return key ? new StripeProvider(key) : simulatedProvider();
}
