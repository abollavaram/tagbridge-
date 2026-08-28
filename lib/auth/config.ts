import type { NextAuthConfig } from 'next-auth';
import { ROLES, type Role } from './roles';
import { authSecret } from './secret';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Edge-safe half of the Auth.js configuration.
 *
 * The middleware runs on the edge runtime and cannot load the database
 * adapter, so the pieces it needs — cookie policy, session shape, the
 * authorized() callback — live here, and `lib/auth/index.ts` adds providers
 * and the adapter for the Node runtime.
 */
export const authConfig = {
  providers: [],
  // Vercel and the local e2e server both front the app with a host header the
  // library cannot verify against a fixed AUTH_URL; the middleware half needs
  // this as much as the Node half does.
  trustHost: true,
  secret: authSecret(),
  session: {
    strategy: 'jwt',
    maxAge: THIRTY_DAYS_SECONDS,
    updateAge: 24 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      name:
        process.env.NODE_ENV === 'production'
          ? '__Secure-authjs.session-token'
          : 'authjs.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: process.env.NODE_ENV === 'production',
      },
    },
  },
  pages: {
    signIn: '/signin',
    error: '/signin',
    verifyRequest: '/signin/check-email',
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = isRole((user as { role?: unknown }).role)
          ? (user as { role: Role }).role
          : 'buyer';
        token.uid = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.role = isRole(token.role) ? token.role : 'buyer';
        session.user.id = typeof token.uid === 'string' ? token.uid : session.user.id;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
