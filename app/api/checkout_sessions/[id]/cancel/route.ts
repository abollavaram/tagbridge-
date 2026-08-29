import { NextResponse } from 'next/server';
import { currentViewer } from '@/lib/auth/guards';
import { AcpError, acpErrorBody, cancelCheckoutSession } from '@/lib/acp/checkout';
import { siteOrigin } from '@/lib/ucp/manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  try {
    const { id } = await params;
    return NextResponse.json(await cancelCheckoutSession(id, siteOrigin(request.url)));
  } catch (error) {
    if (error instanceof AcpError) {
      return NextResponse.json(acpErrorBody(error), { status: error.status });
    }
    throw error;
  }
}
