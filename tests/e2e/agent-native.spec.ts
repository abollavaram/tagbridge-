import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, email: string) {
  await page.goto('/signin');
  await page.getByRole('button', { name: email }).click();
  await page.waitForURL(/\/(account|admin)/);
}

async function cookieHeader(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

test.describe('UCP discovery', () => {
  test('the manifest is served at the well-known path', async ({ request }) => {
    const response = await request.get('/.well-known/ucp');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');

    const profile = await response.json();
    expect(profile.ucp.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(profile.ucp.services['dev.ucp.shopping']).toBeTruthy();
  });

  test('needs no credentials, since discovery precedes them', async ({ request }) => {
    const response = await request.get('/.well-known/ucp');
    expect(response.status()).toBe(200);
  });

  test('every capability schema it points at is actually served', async ({ request }) => {
    const profile = await (await request.get('/.well-known/ucp')).json();
    const urls: string[] = [];
    for (const entries of Object.values(profile.ucp.capabilities) as { schema?: string }[][]) {
      for (const entry of entries) if (entry.schema) urls.push(entry.schema);
    }
    expect(urls.length).toBeGreaterThan(0);

    for (const url of urls) {
      // The manifest carries absolute URLs; follow the path against this host.
      const response = await request.get(new URL(url).pathname);
      expect(response.status(), url).toBe(200);
      expect((await response.json()).$schema, url).toBeTruthy();
    }
  });

  test('the shopping service endpoint it advertises answers', async ({ request }) => {
    const profile = await (await request.get('/.well-known/ucp')).json();
    const endpoint: string = profile.ucp.services['dev.ucp.shopping'][0].endpoint;
    const response = await request.get(
      `${new URL(endpoint).pathname}/catalog/search?query=OPC%20UA%20server`,
    );
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.products.length).toBeGreaterThan(0);
    expect(body.products[0].offers.length).toBeGreaterThan(0);
  });

  test('search returns why each product matched', async ({ request }) => {
    const response = await request.get('/api/ucp/v1/catalog/search?query=Rockwell');
    const body = await response.json();
    expect(body.products[0].match_reasons.length).toBeGreaterThan(0);
  });

  test('search rejects an empty query rather than returning everything', async ({ request }) => {
    expect((await request.get('/api/ucp/v1/catalog/search?query=')).status()).toBe(400);
  });

  test('lookup finds a product by SKU and 404s an unknown one', async ({ request }) => {
    const search = await (await request.get('/api/ucp/v1/catalog/search?query=OPC UA')).json();
    const sku: string = search.products[0].sku;

    const found = await request.get(`/api/ucp/v1/catalog/lookup?sku=${encodeURIComponent(sku)}`);
    expect(found.status()).toBe(200);
    expect((await found.json()).product.sku).toBe(sku);

    expect((await request.get('/api/ucp/v1/catalog/lookup?sku=NOPE-000')).status()).toBe(404);
  });
});

test.describe('the MCP server', () => {
  test('describes itself to a human who opens the URL', async ({ request }) => {
    const response = await request.get('/api/mcp');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.server.name).toBe('tagbridge');
    expect(body.yourRole).toBe('guest');
  });

  test('completes an initialize handshake', async ({ request }) => {
    const response = await request.post('/api/mcp', {
      data: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.result.serverInfo.name).toBe('tagbridge');
    expect(body.result.instructions).toMatch(/never set a price/i);
  });

  test('returns 202 with no body for a notification', async ({ request }) => {
    const response = await request.post('/api/mcp', {
      data: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(response.status()).toBe(202);
  });

  test('lists only catalogue tools to a signed-out client', async ({ request }) => {
    const response = await request.post('/api/mcp', {
      data: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const names = (await response.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('searchProducts');
    expect(names).not.toContain('createQuote');
  });

  test('runs a search for a signed-out client', async ({ request }) => {
    const response = await request.post('/api/mcp', {
      data: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'searchProducts', arguments: { query: 'Modbus gateway' } },
      },
    });
    const result = (await response.json()).result;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).hits.length).toBeGreaterThan(0);
  });

  test('gives a signed-in buyer the quoting tools', async ({ page, request }) => {
    await signIn(page, 'buyer@example.com');
    const response = await request.post('/api/mcp', {
      data: { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      headers: { cookie: await cookieHeader(page), 'content-type': 'application/json' },
    });
    const names = (await response.json()).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('createQuote');
  });

  test('refuses a price sent by an MCP client', async ({ page, request }) => {
    await signIn(page, 'buyer@example.com');
    const search = await request.post('/api/mcp', {
      data: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'searchProducts', arguments: { query: 'OPC UA server' } },
      },
      headers: { cookie: await cookieHeader(page), 'content-type': 'application/json' },
    });
    const hits = JSON.parse((await search.json()).result.content[0].text).hits;
    const variantId = hits[0].variantId;

    const response = await request.post('/api/mcp', {
      data: {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'createQuote',
          arguments: { lines: [{ variantId, qty: 1, unitPriceCents: 1 }] },
        },
      },
      headers: { cookie: await cookieHeader(page), 'content-type': 'application/json' },
    });
    const result = (await response.json()).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/computed by the server/i);
  });

  test('handles a batch of messages', async ({ request }) => {
    const response = await request.post('/api/mcp', {
      data: [
        { jsonrpc: '2.0', id: 7, method: 'ping' },
        { jsonrpc: '2.0', id: 8, method: 'tools/list' },
      ],
    });
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });
});

test.describe('ACP checkout sessions', () => {
  test('discovery is served at the well-known path', async ({ request }) => {
    const response = await request.get('/.well-known/agentic-commerce');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.protocol.name).toBe('agentic-commerce-protocol');
    expect(body.notes.flow).toBe('quote_then_purchase_order');
  });

  test('refuses an unauthenticated create', async ({ request }) => {
    const response = await request.post('/api/checkout_sessions', {
      data: {
        line_items: [{ item: { id: '00000000-0000-4000-8000-000000000000' }, quantity: 1 }],
        currency: 'USD',
      },
    });
    expect(response.status()).toBe(401);
  });

  test('creates, retrieves, updates and cancels a session', async ({ page, request }) => {
    await signIn(page, 'buyer@example.com');
    const cookie = await cookieHeader(page);
    const headers = { cookie, 'content-type': 'application/json' };

    const search = await (await request.get('/api/ucp/v1/catalog/search?query=OPC UA')).json();
    const variantId: string = search.products[0].offers[0].variant_id;

    const created = await request.post('/api/checkout_sessions', {
      data: { line_items: [{ item: { id: variantId }, quantity: 2 }], currency: 'USD' },
      headers,
    });
    expect(created.status()).toBe(201);
    const session = await created.json();
    expect(session.protocol.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const total = session.totals.find((t: { type: string }) => t.type === 'total');
    expect(total.amount).toBeGreaterThan(0);

    const fetched = await request.get(`/api/checkout_sessions/${session.id}`, { headers });
    expect(fetched.status()).toBe(200);

    const updated = await request.post(`/api/checkout_sessions/${session.id}`, {
      data: { line_items: [{ item: { id: variantId }, quantity: 6 }] },
      headers,
    });
    expect(updated.status()).toBe(200);
    const updatedTotal = (await updated.json()).totals.find(
      (t: { type: string }) => t.type === 'total',
    );
    expect(updatedTotal.amount).toBeGreaterThan(total.amount);

    const cancelled = await request.post(`/api/checkout_sessions/${session.id}/cancel`, {
      headers,
    });
    expect(cancelled.status()).toBe(200);
    expect((await cancelled.json()).status).toBe('canceled');
  });

  test('refuses a caller-supplied price with a named error', async ({ page, request }) => {
    await signIn(page, 'buyer@example.com');
    const headers = { cookie: await cookieHeader(page), 'content-type': 'application/json' };

    const response = await request.post('/api/checkout_sessions', {
      data: {
        line_items: [
          { item: { id: '00000000-0000-4000-8000-000000000000', unit_amount: 1 }, quantity: 1 },
        ],
        currency: 'USD',
      },
      headers,
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    // Named, not a generic "unrecognized key": the caller asserted a price and
    // deserves to be told that specifically.
    expect(body.code).toBe('price_not_accepted');
  });
});
