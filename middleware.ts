import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth/config';

const { auth } = NextAuth(authConfig);

// `/approvals` is signed-in-only here and sales-or-admin in the page itself.
// It deliberately sits outside `/admin`: the admin area is admin-only, but
// approving a quote is a sales job, and widening the admin gate to let sales
// in would quietly widen it for every other admin page too.
const PROTECTED_PREFIXES = ['/account', '/quotes', '/orders', '/approvals'];
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
  matcher: [
    '/account/:path*',
    '/quotes/:path*',
    '/orders/:path*',
    '/approvals/:path*',
    '/admin/:path*',
  ],
};
