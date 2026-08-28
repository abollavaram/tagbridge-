import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import Nodemailer from 'next-auth/providers/nodemailer';
import type { Provider } from 'next-auth/providers';
import { z } from 'zod';
import { getDatabase } from '@/lib/db';
import { getDb } from '@/lib/db/client';
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema';
import { authConfig } from './config';

const devLoginSchema = z.object({ email: z.string().email() });

function buildProviders(): Provider[] {
  const providers: Provider[] = [];

  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    providers.push(
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        allowDangerousEmailAccountLinking: false,
      }),
    );
  }

  // The magic-link provider persists its tokens through the adapter, so it is
  // only offered when there is a real database behind the adapter.
  if (process.env.EMAIL_SERVER && process.env.EMAIL_FROM && process.env.DATABASE_URL) {
    providers.push(
      Nodemailer({
        server: process.env.EMAIL_SERVER,
        from: process.env.EMAIL_FROM,
      }),
    );
  }

  // Development and end-to-end tests only. Signs in a seeded demo user by
  // email with no secret, which is exactly why it is refused in production
  // regardless of how the environment is configured.
  if (process.env.AUTH_DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production') {
    providers.push(devLoginProvider());
  } else if (process.env.AUTH_DEV_LOGIN === 'true' && process.env.ALLOW_DEV_LOGIN_IN_PROD === 'true') {
    // Escape hatch for the preview deployment used in the demo. Still refuses
    // any address that is not a seeded demo account.
    providers.push(devLoginProvider());
  }

  return providers;
}

const DEMO_EMAILS = new Set(['buyer@example.com', 'sales@example.com', 'admin@example.com']);

function devLoginProvider(): Provider {
  return Credentials({
    id: 'dev-login',
    name: 'Demo account',
    credentials: { email: { label: 'Email', type: 'email' } },
    async authorize(raw) {
      const parsed = devLoginSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase();
      if (!DEMO_EMAILS.has(email)) return null;
      const db = await getDatabase();
      const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const user = found[0];
      if (!user) return null;
      return { id: user.id, email: user.email, name: user.name, role: user.role };
    },
  });
}

function buildAdapter() {
  // getDb() is synchronous but requires DATABASE_URL. Without one the app runs
  // on PGlite and JWT sessions, which need no adapter.
  if (!process.env.DATABASE_URL) return undefined;
  return DrizzleAdapter(getDb(), {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  });
}

const adapter = buildAdapter();

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  ...(adapter ? { adapter } : {}),
  providers: buildProviders(),
  trustHost: true,
});
