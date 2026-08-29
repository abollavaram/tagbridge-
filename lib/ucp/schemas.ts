/**
 * The JSON Schemas the profile points at.
 *
 * UCP lets a capability declare a `schema` URL describing its payloads, and a
 * manifest that points at a 404 is worse than one that points nowhere. These
 * are served from the app so they cannot drift from the routes they describe.
 */

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

export const UCP_SERVICE_SCHEMAS: Record<string, (origin: string) => object> = {
  'catalog-search': (origin) => ({
    $schema: DRAFT,
    $id: `${origin}/api/ucp/v1/schemas/catalog-search.json`,
    title: 'TagBridge catalog search',
    type: 'object',
    properties: {
      request: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 200 },
          pagination: {
            type: 'object',
            properties: { limit: { type: 'integer', minimum: 1, maximum: 25 } },
          },
        },
        additionalProperties: false,
      },
      response: {
        type: 'object',
        required: ['ucp', 'products', 'total'],
        properties: {
          ucp: { type: 'object', required: ['version'] },
          total: { type: 'integer' },
          products: { type: 'array', items: { $ref: '#/$defs/product' } },
        },
      },
    },
    $defs: { product: productSchema() },
  }),

  'catalog-lookup': (origin) => ({
    $schema: DRAFT,
    $id: `${origin}/api/ucp/v1/schemas/catalog-lookup.json`,
    title: 'TagBridge catalog lookup',
    type: 'object',
    properties: {
      request: {
        type: 'object',
        description: 'Query string: sku or id (a slug is also accepted).',
        required: ['sku'],
        properties: { sku: { type: 'string' } },
      },
      response: {
        type: 'object',
        required: ['ucp', 'product'],
        properties: {
          ucp: { type: 'object', required: ['version'] },
          product: { $ref: '#/$defs/product' },
        },
      },
    },
    $defs: { product: productSchema() },
  }),

  checkout: (origin) => ({
    $schema: DRAFT,
    $id: `${origin}/api/ucp/v1/schemas/checkout.json`,
    title: 'TagBridge checkout',
    description:
      'Checkout here is quote-shaped. A session drafts a quote priced entirely by the server; no price may be supplied by the caller, and an agent-drafted quote requires a human approval before it is sent.',
    type: 'object',
    properties: {
      request: {
        type: 'object',
        required: ['line_items'],
        properties: {
          line_items: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              required: ['variant_id', 'quantity'],
              properties: {
                variant_id: { type: 'string', format: 'uuid' },
                quantity: { type: 'integer', minimum: 1, maximum: 9999 },
              },
              // No price field exists, at any nesting level. That is the
              // guarantee, expressed where a caller can read it.
              additionalProperties: false,
            },
          },
          buyer: {
            type: 'object',
            properties: { email: { type: 'string', format: 'email' } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      response: {
        type: 'object',
        required: ['ucp', 'quote'],
        properties: {
          ucp: { type: 'object', required: ['version'] },
          quote: {
            type: 'object',
            required: ['id', 'number', 'status', 'currency', 'totals', 'line_items'],
            properties: {
              id: { type: 'string' },
              number: { type: 'string' },
              status: { type: 'string' },
              currency: { type: 'string' },
              requires_human_approval: { type: 'boolean' },
              totals: { type: 'array' },
              line_items: { type: 'array' },
            },
          },
        },
      },
    },
  }),
};

function productSchema() {
  return {
    type: 'object',
    required: ['id', 'sku', 'name', 'offers'],
    properties: {
      id: { type: 'string' },
      sku: { type: 'string' },
      name: { type: 'string' },
      category: { type: 'string' },
      description: { type: 'string' },
      protocols: { type: 'array', items: { type: 'string' } },
      vendor_compatibility: { type: 'array', items: { type: 'string' } },
      license_type: { type: 'string', enum: ['perpetual', 'subscription'] },
      url: { type: 'string', format: 'uri' },
      match_reasons: {
        type: 'array',
        items: { type: 'string' },
        description: 'Why this product was returned, from the reranker.',
      },
      offers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['variant_id', 'sku', 'currency', 'unit_amount'],
          properties: {
            variant_id: { type: 'string' },
            sku: { type: 'string' },
            tier: { type: 'string' },
            tag_capacity: { type: ['integer', 'null'] },
            currency: { type: 'string' },
            unit_amount: { type: 'integer', description: 'Minor units.' },
            billing_interval: { type: 'string' },
            volume_breaks: {
              type: 'array',
              items: {
                type: 'object',
                required: ['min_quantity', 'unit_amount'],
                properties: {
                  min_quantity: { type: 'integer' },
                  unit_amount: { type: 'integer' },
                },
              },
            },
          },
        },
      },
    },
  };
}
