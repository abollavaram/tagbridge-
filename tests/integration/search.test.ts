import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { products } = await import('@/lib/db/schema');
const { search } = await import('@/lib/search/pipeline');
const { bm25Search, naiveBm25Search, partNumberSearch, vectorSearch } = await import(
  '@/lib/search/retrievers'
);
const { getEmbedder } = await import('@/lib/search/embedding');
const { firstRow } = await import('@/lib/db/rows');

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;

async function skus(): Promise<Set<string>> {
  const rows = await db.select({ sku: products.sku }).from(products).where(eq(products.active, true));
  return new Set(rows.map((r) => r.sku));
}

beforeAll(async () => {
  db = await getDatabase();
  const present = await skus();
  expect(present.size).toBe(50);
}, 180_000);

describe('the index is built', () => {
  it('has an embedding for every active product', async () => {
    const rows = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from product_embeddings e join products p on p.id = e.product_id
      where p.active
    `);
    expect(firstRow<{ count: number }>(rows)?.count).toBe(50);
  });
});

describe('retrieval legs', () => {
  it('BM25 finds an exact part number', async () => {
    const rows = await bm25Search(['TB-OPCUA-4100'], 5);
    expect(rows[0]?.sku).toBe('TB-OPCUA-4100');
  });

  it('the naive baseline cannot find a part number at all', async () => {
    // Name and description carry no SKU, which is precisely the failure the
    // project exists to fix.
    const rows = await naiveBm25Search(['TB-OPCUA-4100'], 5);
    expect(rows.map((r) => r.sku)).not.toContain('TB-OPCUA-4100');
  });

  it('part-number lookup matches a variant SKU back to its product', async () => {
    const rows = await partNumberSearch(['TB-OPCUA-4100-M'], 5);
    expect(rows.map((r) => r.sku)).toContain('TB-OPCUA-4100');
  });

  it('vector search returns ranked, scored results', async () => {
    const embedder = await getEmbedder();
    const rows = await vectorSearch(await embedder.embed('sparkplug edge node'), 5);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.score).toBeLessThanOrEqual(rows[i - 1]!.score);
    }
  });

  it('spec values are searchable, not just spec keys', async () => {
    const rows = await bm25Search(['SAML', 'OIDC'], 5);
    expect(rows.map((r) => r.sku)).toContain('TB-HMI-8400');
  });

  it('returns nothing for empty input rather than everything', async () => {
    expect(await bm25Search([], 5)).toEqual([]);
    expect(await vectorSearch([], 5)).toEqual([]);
    expect(await partNumberSearch([], 5)).toEqual([]);
  });
});

describe('the pipeline end to end', () => {
  it('puts an exact part number first', async () => {
    const r = await search('TB-GW-5200');
    expect(r.hits[0]?.sku).toBe('TB-GW-5200');
    expect(r.intent.intent).toBe('specific-product');
  });

  it('finds Allen-Bradley products for a Rockwell query', async () => {
    const r = await search('Rockwell PLC connector');
    expect(r.hits.slice(0, 3).map((h) => h.sku)).toContain('TB-OPCUA-4100');
    expect(r.expandedTerms).toContain('allen-bradley');
  });

  it('answers a problem-shaped query with the connector that solves it', async () => {
    const r = await search('get tag data from a ControlLogix into SQL Server');
    expect(r.hits.slice(0, 3).map((h) => h.sku)).toContain('TB-HIST-6100');
  });

  it('routes a compatibility question to the compatibility intent', async () => {
    const r = await search('does this work with Modbus RTU over serial');
    expect(r.intent.intent).toBe('compatibility-question');
    expect(r.hits[0]?.sku).toBe('TB-GW-5200');
  });

  it('survives a misspelling', async () => {
    const r = await search('modbis gateway');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.slice(0, 3).some((h) => h.sku.startsWith('TB-GW-'))).toBe(true);
  });

  it('explains why each result was chosen', async () => {
    const r = await search('Rockwell PLC connector');
    expect(r.hits[0]?.reasons.length).toBeGreaterThan(0);
  });

  it('never repeats a reason for one hit', async () => {
    const r = await search('Microsoft SQL historian writes');
    for (const hit of r.hits) {
      expect(new Set(hit.reasons).size, hit.sku).toBe(hit.reasons.length);
    }
  });

  it('returns nothing for an empty query instead of the whole catalogue', async () => {
    const r = await search('   ');
    expect(r.hits).toEqual([]);
  });

  it('honours the requested limit', async () => {
    const r = await search('opc ua server', { limit: 3 });
    expect(r.hits.length).toBeLessThanOrEqual(3);
  });

  it('never returns the same product twice', async () => {
    const r = await search('modbus gateway serial', { limit: 8 });
    const ids = r.hits.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays well inside the latency budget', async () => {
    const r = await search('get tag data from a ControlLogix into SQL Server');
    expect(r.tookMs).toBeLessThan(400);
  });

  it('gives each mode its own behaviour', async () => {
    const naive = await search('TB-OPCUA-4100', { mode: 'bm25-naive' });
    const strong = await search('TB-OPCUA-4100', { mode: 'bm25' });
    expect(naive.hits.map((h) => h.sku)).not.toContain('TB-OPCUA-4100');
    expect(strong.hits[0]?.sku).toBe('TB-OPCUA-4100');
  });
});
