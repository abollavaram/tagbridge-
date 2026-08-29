import { NextResponse } from 'next/server';
import { siteOrigin } from '@/lib/ucp/manifest';
import { UCP_SERVICE_SCHEMAS } from '@/lib/ucp/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cors = { 'access-control-allow-origin': '*' };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await params;
  const key = name.replace(/\.json$/, '');
  const build = UCP_SERVICE_SCHEMAS[key];

  if (!build) {
    return NextResponse.json(
      { error: `no schema named ${key}`, available: Object.keys(UCP_SERVICE_SCHEMAS) },
      { status: 404, headers: cors },
    );
  }

  return NextResponse.json(build(siteOrigin(request.url)), {
    headers: { ...cors, 'cache-control': 'public, max-age=3600' },
  });
}
