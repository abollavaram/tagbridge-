import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, backoffMs } from '@/lib/sync/events';
import { erpReference } from '@/lib/sync/erp';
import { mapStripeStatus } from '@/lib/sync/provider';

describe('retry backoff', () => {
  it('grows exponentially', () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
    expect(backoffMs(4)).toBe(16_000);
  });

  it('is strictly increasing until it caps', () => {
    for (let attempt = 1; attempt < 6; attempt += 1) {
      expect(backoffMs(attempt + 1)).toBeGreaterThanOrEqual(backoffMs(attempt));
    }
  });

  it('caps so a long-dead endpoint does not schedule a retry hours out', () => {
    expect(backoffMs(20)).toBe(60_000);
  });

  it('gives up after five attempts, as the spec requires', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});

describe('ERP references', () => {
  it('are deterministic, so a re-push updates rather than duplicates', () => {
    expect(erpReference('sub_demo_1001')).toBe(erpReference('sub_demo_1001'));
  });

  it('differ for different subscriptions', () => {
    expect(erpReference('sub_demo_1001')).not.toBe(erpReference('sub_demo_1002'));
  });

  it('are well-formed even when the id carries no digits', () => {
    expect(erpReference('sub_abc')).toBe('ERP-000000');
  });
});

describe('provider status mapping', () => {
  it('passes through the statuses we model', () => {
    for (const status of ['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete']) {
      expect(mapStripeStatus(status)).toBe(status);
    }
  });

  it('maps incomplete_expired onto incomplete rather than dropping it', () => {
    expect(mapStripeStatus('incomplete_expired')).toBe('incomplete');
  });

  it('maps paused onto past_due, which is the entitlement-equivalent state', () => {
    expect(mapStripeStatus('paused')).toBe('past_due');
  });

  it('never invents an active subscription from a status it does not know', () => {
    expect(mapStripeStatus('something_new_stripe_added')).toBe('canceled');
  });
});
