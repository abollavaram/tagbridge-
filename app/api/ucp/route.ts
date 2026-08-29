import { NextResponse } from 'next/server';
import { buildUcpProfile, siteOrigin } from '@/lib/ucp/manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves the UCP profile.
 *
 * Reached at `/.well-known/ucp` through a rewrite in `next.config.ts` — the
 * App Router will not route a directory whose name starts with a dot, and a
 * rewrite is a clearer way to say "this well-known path is served by this
 * handler" than a filesystem trick would be.
 *
 * Unauthenticated on purpose: discovery is the one call an agent makes before
 * it has any credentials, and a profile behind auth cannot be discovered.
 */
export function GET(request: Request): NextResponse {
  const profile = buildUcpProfile(siteOrigin(request.url));

  return NextResponse.json(profile, {
    headers: {
      'content-type': 'application/json',
      // Discovery is read constantly and changes rarely.
      'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
      // An agent may fetch this from anywhere.
      'access-control-allow-origin': '*',
    },
  });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
    },
  });
}
