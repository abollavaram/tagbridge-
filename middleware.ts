import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth/config';

const { auth } = NextAuth(authConfig);

const PROTECTED_PREFIXES = ['/account', '/quotes', '/orders'];
const ADMIN_PREFIXES = ['/admin'];

/**
 * First gate only. Every protected page and server action re-checks the
 * session server-side; middleware exists to keep unauthenticated traffic off
 * those routes, not to be the authorization decision.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAdmin = ADMIN_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isProtected && !isAdmin) return NextResponse.next();

  if (!req.auth?.user) {
    const url = new URL('/signin', req.nextUrl.origin);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  if (isAdmin && req.auth.user.role !== 'admin') {
    return NextResponse.redirect(new URL('/403', req.nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/account/:path*', '/quotes/:path*', '/orders/:path*', '/admin/:path*'],
};
