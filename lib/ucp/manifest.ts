import { getEnv } from '@/lib/env';

/**
 * The UCP profile served at `/.well-known/ucp`.
 *
 * UCP's discovery model is that a business publishes one machine-readable
 * document saying what it can do, and an agent reads that before it reads
 * anything else. So this is the first thing an agent ever sees of TagBridge,
 * and the shape is not ours to invent — it is validated in the test suite
 * against the vendored schema snapshot in `spec-snapshots/ucp`.
 *
 * Two decisions worth stating, because both are refusals to overclaim:
 *
 *  - Only capabilities that actually work are advertised. Catalogue search,
 *    lookup and checkout are real endpoints backed by the same code the
 *    storefront uses. Cart, discount and fulfillment are not implemented, so
 *    they are absent rather than declared-and-broken. An agent that trusts a
 *    manifest and finds a 404 has been lied to.
 *  - No payment handler is configured on the demo, so `payment_handlers` is
 *    an empty registry and the only checkout path is the purchase-order one.
 *    The field is required by the schema; the honest value is empty, not a
 *    handler that would fail on first use.
 */

/** The protocol version this profile is built and validated against. */
export const UCP_VERSION = '2026-08-25';

/** Where the shopping service lives. Agents read this, not our route table. */
const SERVICE_BASE = '/api/ucp/v1';

export interface UcpEntity {
  version: string;
  spec?: string;
  schema?: string;
  id?: string;
  config?: Record<string, unknown>;
}

export interface UcpService extends UcpEntity {
  transport: string;
  endpoint?: string;
}

export interface UcpProfile {
  ucp: {
    version: string;
    services: Record<string, UcpService[]>;
    capabilities: Record<string, UcpEntity[]>;
    payment_handlers: Record<string, UcpEntity[]>;
  };
}

/**
 * The site's own origin.
 *
 * A profile full of relative paths is useless to an agent that fetched it
 * from somewhere else, so endpoints are absolute. Falling back to the request
 * origin rather than hardcoding a domain keeps preview deployments correct.
 */
export function siteOrigin(requestUrl?: string): string {
  const configured = getEnv().NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (requestUrl) return new URL(requestUrl).origin;
  return 'http://localhost:3000';
}

export function buildUcpProfile(origin: string): UcpProfile {
  const spec = `https://ucp.dev/${UCP_VERSION}/specification/overview`;

  return {
    ucp: {
      version: UCP_VERSION,
      services: {
        'dev.ucp.shopping': [
          {
            version: UCP_VERSION,
            spec,
            transport: 'rest',
            endpoint: `${origin}${SERVICE_BASE}`,
          },
        ],
      },
      capabilities: {
        // Search is the capability this storefront is actually about: the
        // whole project exists because catalogue search built for consumer
        // retail fails an engineer searching by symptom.
        'dev.ucp.shopping.catalog.search': [
          {
            version: UCP_VERSION,
            schema: `${origin}${SERVICE_BASE}/schemas/catalog-search.json`,
            config: {
              // Stated so an agent knows what it is getting rather than
              // discovering it by trial: this index understands protocol and
              // vendor synonyms, and ranks on a hybrid of lexical and dense
              // retrieval with a feature reranker.
              query_understanding: ['protocol_synonyms', 'vendor_synonyms', 'part_numbers'],
              retrieval: 'hybrid_bm25_dense_rrf',
              max_results: 25,
            },
          },
        ],
        'dev.ucp.shopping.catalog.lookup': [
          {
            version: UCP_VERSION,
            schema: `${origin}${SERVICE_BASE}/schemas/catalog-lookup.json`,
          },
        ],
        'dev.ucp.shopping.checkout': [
          {
            version: UCP_VERSION,
            schema: `${origin}${SERVICE_BASE}/schemas/checkout.json`,
            config: {
              // Industrial buying is quote-shaped, and saying so in the
              // manifest is the point: an agent that assumes a card checkout
              // will fail here, and it should learn that from discovery
              // rather than from a declined payment.
              flow: 'quote_then_purchase_order',
              agent_drafted_quotes_require_human_approval: true,
              prices_are_server_computed: true,
            },
          },
        ],
      },
      // Required by the schema, and empty is the truthful value: this
      // deployment takes purchase orders and does not process cards.
      payment_handlers: {},
    },
  };
}
