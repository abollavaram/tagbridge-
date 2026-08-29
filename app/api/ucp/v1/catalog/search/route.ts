import { NextResponse } from 'next/server';
import { siteOrigin } from '@/lib/ucp/manifest';
import { ucpCatalogSearch } from '@/lib/ucp/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cors = { 'access-control-allow-origin': '*' };

/** GET for a simple agent; POST for one sending the UCP search_request body. */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const query = url.searchParams.get('query') ?? url.searchParams.get('q') ?? '';
  const limit = Number(url.searchParams.get('limit') ?? 10);
  return respond(query, limit, request.url);
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: { query?: unknown; pagination?: { limit?: unknown } } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400, headers: cors });
  }
  return respond(String(body.query ?? ''), Number(body.pagination?.limit ?? 10), request.url);
}

async function respond(query: string, limit: number, requestUrl: string): Promise<NextResponse> {
  if (query.trim().length === 0) {
    return NextResponse.json(
      { error: 'query is required' },
      { status: 400, headers: cors },
    );
  }
  const bounded = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 25) : 10;
  const result = await ucpCatalogSearch(query, bounded, siteOrigin(requestUrl));
  return NextResponse.json(result, { headers: cors });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...cors, 'access-control-allow-methods': 'GET, POST, OPTIONS' },
  });
}
