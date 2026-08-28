/**
 * Which sign-in providers this deployment offers.
 *
 * Google and the email magic link appear when their credentials are present.
 * The seeded demo accounts appear when nothing else is configured — a
 * deployment with no sign-in at all is useless, and this one is a portfolio
 * demo whose three accounts hold no real data. It accepts no address outside
 * that seeded set, and `AUTH_DEV_LOGIN=false` turns it off outright.
 */
export interface ProviderAvailability {
  google: boolean;
  email: boolean;
  demo: boolean;
}

export const DEMO_EMAILS = [
  'buyer@example.com',
  'sales@example.com',
  'admin@example.com',
] as const;

export function providerAvailability(env: NodeJS.ProcessEnv = process.env): ProviderAvailability {
  const google = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  const email = Boolean(env.EMAIL_SERVER && env.EMAIL_FROM && env.DATABASE_URL);

  let demo: boolean;
  if (env.AUTH_DEV_LOGIN === 'false') demo = false;
  else if (env.AUTH_DEV_LOGIN === 'true') demo = true;
  else demo = !google && !email;

  return { google, email, demo };
}
