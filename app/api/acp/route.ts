import { NextResponse } from 'next/server';
import { ACP_VERSION } from '@/lib/acp/checkout';
import { siteOrigin } from '@/lib/ucp/manifest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ACP discovery, served at `/.well-known/agentic-commerce`.
 *
 * Mirrors UCP's principle: say what is here before an agent has to find out
 * by calling. `complete` is deliberately absent from the service list —
 * completing a purchase here raises a purchase order through the storefront,
 * and there is no card path to advertise.
 */
export function GET(request: Request): NextResponse {
  const origin = siteOrigin(request.url);

  return NextResponse.json(
    {
      protocol: {
        name: 'agentic-commerce-protocol',
        version: ACP_VERSION,
        supported_versions: [ACP_VERSION],
        documentation_url: 'https://agenticcommerce.dev/docs/reference/checkout',
      },
      api_base_url: `${origin}/api`,
      transports: ['rest'],
      capabilities: {
        services: ['checkout_sessions.create', 'checkout_sessions.get', 'checkout_sessions.update', 'checkout_sessions.cancel'],
        supported_currencies: ['USD'],
        supported_locales: ['en-US'],
        // Stated plainly so an agent does not plan a card flow it cannot finish.
        extensions: [],
      },
      notes: {
        flow: 'quote_then_purchase_order',
        prices_are_server_computed: true,
        payment_handlers: [],
      },
    },
    { headers: { 'access-control-allow-origin': '*' } },
  );
}
