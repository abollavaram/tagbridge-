import { NextResponse } from 'next/server';
import { currentViewer } from '@/lib/auth/guards';
import { containsPriceField } from '@/lib/commerce/pricing';
import {
  AcpError,
  acpErrorBody,
  createCheckoutSession,
  createSessionSchema,
} from '@/lib/acp/checkout';
import { siteOrigin } from '@/lib/ucp/manifest';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /checkout_sessions — ACP session creation.
 *
 * The price check runs before the schema does. ACP's own `Item` permits a
 * `unit_amount`, and a caller sending one is not making a schema mistake, they
 * are asserting a price. Refusing that with a named error says so; letting
 * `.strict()` reject it as an unknown key would be technically correct and
 * tell them nothing.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const log = requestLogger(requestIdFrom(request.headers));

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
          'Prices are computed by the server from the published volume breaks. Send item ids and quantities only.',
          400,
          'line_items',
        ),
      ),
      { status: 400 },
    );
  }

  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      acpErrorBody(
        new AcpError(
          'invalid_request',
          parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
          400,
        ),
      ),
      { status: 400 },
    );
  }

  const viewer = await currentViewer();
  if (!viewer) {
    return NextResponse.json(
      acpErrorBody(
        new AcpError('authentication_required', 'sign in before creating a session', 401),
      ),
      { status: 401 },
    );
  }

  try {
    const session = await createCheckoutSession(
      parsed.data,
      { userId: viewer.id, role: viewer.role },
      siteOrigin(request.url),
    );
    log.info({ sessionId: session.id, status: session.status }, 'acp session created');
    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    if (error instanceof AcpError) {
      return NextResponse.json(acpErrorBody(error), { status: error.status });
    }
    throw error;
  }
}
