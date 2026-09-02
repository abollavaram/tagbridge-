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
 * The Content-Security-Policy, with a per-request nonce.
 *
 * It lives here rather than in `next.config.ts` for a reason worth recording:
 * a static `script-src 'self'` blocks Next's own inline bootstrap scripts,
 * which carry the RSC payload. Setting it that way rendered every page in the
 * app as an empty body — the site looked up and served nothing. The e2e suite
 * caught it; a header nobody exercises is a header nobody notices breaking.
 *
 * A nonce is the correct answer: Next stamps it onto the scripts it emits, so
 * the framework's own code runs and injected script does not. The cost is that
 * a nonce is per-request, so pages carrying one cannot be served from the
 * static cache — paid deliberately, and only on the routes that render HTML.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Tailwind injects styles; there is no nonce-able seam for them.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.stripe.com",
    // Named now so the card path can be enabled without weakening this later.
    'frame-src https://js.stripe.com https://hooks.stripe.com',
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/** True for anything that is not an HTML document — assets need no CSP. */
function isAsset(pathname: string): boolean {
  return (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/api/') ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|txt|xml|json|woff2?)$/.test(pathname)
  );
}

/**
 * First gate only. Every protected page and server action re-checks the
 * session server-side; middleware exists to keep unauthenticated traffic off
 * those routes, not to be the authorization decision.
 */
export default auth((req) => {
  const { pathname } = req.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  const isAdmin = ADMIN_PREFIXES.some((p) => pathname.startsWith(p));

  if (isProtected || isAdmin) {
    if (!req.auth?.user) {
      const url = new URL('/signin', req.nextUrl.origin);
      url.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(url);
    }
    if (isAdmin && req.auth.user.role !== 'admin') {
      return NextResponse.redirect(new URL('/403', req.nextUrl.origin));
    }
  }

  if (isAsset(pathname)) return NextResponse.next();

  // The nonce travels to the renderer on the request, and to the browser on
  // the response. Both halves are required: one without the other either
  // blocks the framework or permits anything.
  // Web Crypto, not node:crypto — middleware runs on the edge runtime, where
  // the node builtin is not available and the build fails outright.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', contentSecurityPolicy(nonce));
  return response;
});

export const config = {
  // Everything except static assets and image optimisation, so the policy is
  // on every document rather than only the guarded ones.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
