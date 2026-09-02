import { authSecret } from '@/lib/auth/secret';

/**
 * The webhook signing secret.
 *
 * `STRIPE_WEBHOOK_SECRET` when configured. When it is not — a clean clone, a
 * test run, the zero-credentials demo — the endpoint still refuses unsigned
 * requests rather than falling open, because an unauthenticated endpoint that
 * writes subscription state is a worse default than one nobody can call.
 *
 * The fallback derives from the session secret, which is already random per
 * environment and never committed. That gives the demo a real secret, keeps
 * the signature path genuinely exercised end to end, and means an attacker
 * who does not have it cannot post events — the same guarantee the configured
 * case gives, with a key nobody had to set.
 */
export function webhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET ?? `derived:webhook:${authSecret()}`;
}

/** Whether a real provider secret is configured, for the dashboard to report. */
export function usingConfiguredWebhookSecret(): boolean {
  return Boolean(process.env.STRIPE_WEBHOOK_SECRET);
}
