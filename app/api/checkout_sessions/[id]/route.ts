import { NextResponse } from 'next/server';
import { currentViewer } from '@/lib/auth/guards';
import { containsPriceField } from '@/lib/commerce/pricing';
import {
  AcpError,
  acpErrorBody,
  getCheckoutSession,
  updateCheckoutSession,
  updateSessionSchema,
} from '@/lib/acp/checkout';
import { siteOrigin } from '@/lib/ucp/manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(error: unknown): NextResponse {
  if (error instanceof AcpError) {
    return NextResponse.json(acpErrorBody(error), { status: error.status });
  }
  throw error;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const viewer = await currentViewer();
  if (!viewer) {
    return NextResponse.json(
      acpErrorBody(new AcpError('authentication_required', 'sign in first', 401)),
      { status: 401 },
    );
  }
  try {
    const { id } = await params;
    return NextResponse.json(await getCheckoutSession(id, siteOrigin(request.url)));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const viewer = await currentViewer();
  if (!viewer) {
    return NextResponse.json(
      acpErrorBody(new AcpError('authentication_required', 'sign in first', 401)),
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      acpErrorBody(new AcpError('invalid_json', 'request body is not valid JSON')),
      { status: 400 },
    );
  }

  if (containsPriceField(body)) {
    return NextResponse.json(
      acpErrorBody(
        new AcpError(
          'price_not_accepted',
          'Prices are computed by the server. Send item ids and quantities only.',
          400,
          'line_items',
        ),
      ),
      { status: 400 },
    );
  }

  const parsed = updateSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      acpErrorBody(
        new AcpError(
          'invalid_request',
          parsed.error.issues.map((i) => i.message).join('; '),
        ),
      ),
      { status: 400 },
    );
  }

  try {
    const { id } = await params;
    return NextResponse.json(
      await updateCheckoutSession(id, parsed.data, siteOrigin(request.url)),
    );
  } catch (error) {
    return fail(error);
  }
}
