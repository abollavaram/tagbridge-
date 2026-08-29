import { NextResponse } from 'next/server';
import { siteOrigin } from '@/lib/ucp/manifest';
import { ucpCatalogLookup } from '@/lib/ucp/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cors = { 'access-control-allow-origin': '*' };

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const identifier = url.searchParams.get('sku') ?? url.searchParams.get('id') ?? '';
  if (identifier.trim().length === 0) {
    return NextResponse.json({ error: 'sku or id is required' }, { status: 400, headers: cors });
  }

  const result = await ucpCatalogLookup(identifier, siteOrigin(request.url));
  // 404 rather than a null body: an agent should not have to inspect the
  // payload to learn the product does not exist.
  if (!result.product) {
    return NextResponse.json(
      { ucp: result.ucp, error: `no product matches ${identifier}` },
      { status: 404, headers: cors },
    );
  }
  return NextResponse.json(result, { headers: cors });
}

export function OPTIONS(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { ...cors, 'access-control-allow-methods': 'GET, OPTIONS' },
  });
}
