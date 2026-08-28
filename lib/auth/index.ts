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
import { DEMO_EMAILS, providerAvailability } from './providers';

const devLoginSchema = z.object({ email: z.string().email() });

function buildProviders(): Provider[] {
  const providers: Provider[] = [];
  const available = providerAvailability();

  if (available.google && process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
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
  if (available.email && process.env.EMAIL_SERVER && process.env.EMAIL_FROM) {
    providers.push(
      Nodemailer({
        server: process.env.EMAIL_SERVER,
        from: process.env.EMAIL_FROM,
      }),
    );
  }

  if (available.demo) providers.push(devLoginProvider());

  return providers;
}

const DEMO_EMAIL_SET = new Set<string>(DEMO_EMAILS);

function devLoginProvider(): Provider {
  return Credentials({
    id: 'dev-login',
    name: 'Demo account',
    credentials: { email: { label: 'Email', type: 'email' } },
    async authorize(raw) {
      const parsed = devLoginSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase();
      if (!DEMO_EMAIL_SET.has(email)) return null;
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
