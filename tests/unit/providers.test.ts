import { describe, expect, it } from 'vitest';
import { providerAvailability } from '@/lib/auth/providers';

const GOOGLE = { AUTH_GOOGLE_ID: 'id', AUTH_GOOGLE_SECRET: 'secret' };
const EMAIL = {
  EMAIL_SERVER: 'smtp://localhost:25',
  EMAIL_FROM: 'no-reply@example.com',
  DATABASE_URL: 'postgres://localhost/db',
};

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return extra as NodeJS.ProcessEnv;
}

describe('provider availability', () => {
  it('offers the demo accounts when nothing else is configured', () => {
    expect(providerAvailability(env())).toEqual({ google: false, email: false, demo: true });
  });

  it('withdraws the demo accounts once a real provider exists', () => {
    expect(providerAvailability(env(GOOGLE)).demo).toBe(false);
    expect(providerAvailability(env(EMAIL)).demo).toBe(false);
  });

  it('respects an explicit opt-out even with no other provider', () => {
    expect(providerAvailability(env({ AUTH_DEV_LOGIN: 'false' })).demo).toBe(false);
  });

  it('respects an explicit opt-in alongside a real provider', () => {
    expect(providerAvailability(env({ ...GOOGLE, AUTH_DEV_LOGIN: 'true' })).demo).toBe(true);
  });

  it('does not offer the magic link without a database to store its tokens', () => {
    const { DATABASE_URL: _unused, ...withoutDb } = EMAIL;
    expect(providerAvailability(env(withoutDb)).email).toBe(false);
  });

  it('needs both halves of each credential pair', () => {
    expect(providerAvailability(env({ AUTH_GOOGLE_ID: 'id' })).google).toBe(false);
    expect(providerAvailability(env({ EMAIL_SERVER: 'smtp://x', DATABASE_URL: 'postgres://x' })).email).toBe(false);
  });
});
