import { z } from 'zod';

/**
 * Runtime environment contract. Validated lazily so that `next build` and unit
 * tests do not require a full production environment to be present.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Postgres connection string. When absent the app falls back to an in-process
   * PGlite database, which is what the test suite and a clean clone use.
   */
  DATABASE_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  AUTH_URL: z.string().url().optional(),
  AUTH_GOOGLE_ID: z.string().min(1).optional(),
  AUTH_GOOGLE_SECRET: z.string().min(1).optional(),
  EMAIL_SERVER: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Enables the seeded demo-account sign-in. Refused in production unless
   *  ALLOW_DEV_LOGIN_IN_PROD is also set, which only the demo deployment does. */
  AUTH_DEV_LOGIN: z.enum(['true', 'false']).optional(),
  ALLOW_DEV_LOGIN_IN_PROD: z.enum(['true', 'false']).optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: drop the memoised env so a test can vary process.env. */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}
