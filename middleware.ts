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
 * The Content-Security-Policy.
 *
 * This took two attempts and the second one is a deliberate compromise, so it
 * is worth writing down rather than leaving as a mysterious `unsafe-inline`.
 *
 * Attempt one was `script-src 'self'` in the static headers. That blocks
 * Next's own inline bootstrap — the scripts carrying the RSC payload — so
 * every page in the app returned 200 and rendered an empty body.
 *
 * Attempt two was a per-request nonce here. That works on a dynamically
 * rendered page and is silently broken on a cached one: the HTML comes out of
 * the ISR cache carrying the nonce it was generated with, while the response
 * header carries a fresh one. They do not match, so the same scripts are
 * blocked again — and only on the pages people actually land on, because those
 * are the ones worth caching. Lighthouse caught it as a best-practices drop
 * from 100 to 92; the real cost was that the home and product pages had
 * quietly stopped hydrating.
 *
 * A nonce would require rendering every page dynamically. This app caches the
 * home and product pages on purpose — `force-dynamic` there defers metadata
 * resolution and streams the title and description into the body, where a
 * crawler that does not run JavaScript never sees them. Trading working SEO
 * for a stricter script-src is the wrong way round for a storefront.
 *
 * So: `'unsafe-inline'` on script-src, everything else kept strict. This still
 * stops external script origins, plugins, framing, base-tag hijacking and
 * off-site form posts. It does not stop injected inline script, and saying so
 * plainly beats a header that looks stronger than it is. The application ships
 * no third-party JavaScript, which is what keeps the remaining surface small.
 */
function contentSecurityPolicy(secure: boolean): string {
  return [
    "default-src 'self'",
    // See above. Next's inline bootstrap has no nonce-able seam on a cached page.
    "script-src 'self' 'unsafe-inline'",
    // Tailwind injects styles; likewise no seam.
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
    // Only where there is something to upgrade to. On a plain-HTTP origin — a
    // local run, or CI's own server — this rewrites same-origin redirects to
    // https and they fail with an SSL error: a broken navigation in exchange
    // for nothing.
    ...(secure ? ['upgrade-insecure-requests'] : []),
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

  // Static across requests, which is what lets it sit on a cached page
  // without the header and the HTML disagreeing.
  const secure =
    req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';

  const response = NextResponse.next();
  response.headers.set('Content-Security-Policy', contentSecurityPolicy(secure));
  return response;
});

export const config = {
  // Everything except static assets and image optimisation, so the policy is
  // on every document rather than only the guarded ones.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
