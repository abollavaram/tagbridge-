import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

delete process.env.DATABASE_URL;

const { getDatabase } = await import('@/lib/db');
const { graphEdges, graphNodes, products } = await import('@/lib/db/schema');
const { nodeKey } = await import('@/lib/graph/build');
const { findNode, graphCounts, graphSearch, listNodesByKind, neighbourhood, resolveNodes } =
  await import('@/lib/graph/walk');

type Db = Awaited<ReturnType<typeof getDatabase>>;
let db: Db;

beforeAll(async () => {
  db = await getDatabase();
}, 180_000);

describe('the graph is built from the catalogue', () => {
  it('has a node for every active product', async () => {
    const productRows = await db.select({ id: products.id }).from(products).where(eq(products.active, true));
    const nodes = await db.select().from(graphNodes).where(eq(graphNodes.kind, 'product'));
    expect(nodes).toHaveLength(productRows.length);
  });

  it('links every product node back to a real product row', async () => {
    const nodes = await db.select().from(graphNodes).where(eq(graphNodes.kind, 'product'));
    for (const node of nodes) expect(node.productId, node.key).toBeTruthy();
  });

  it('has protocol, vendor and category nodes', async () => {
    const counts = await graphCounts();
    const kinds = new Map(counts.byKind.map((k) => [k.kind, k.count]));
    expect(kinds.get('protocol') ?? 0).toBeGreaterThan(10);
    expect(kinds.get('vendor') ?? 0).toBeGreaterThan(10);
    expect(kinds.get('category') ?? 0).toBe(7);
  });

  it('has more edges than nodes, which is what makes it a graph', async () => {
    const counts = await graphCounts();
    expect(counts.edges).toBeGreaterThan(counts.nodes);
  });

  it('never points an edge at a node that does not exist', async () => {
    const nodes = await db.select({ id: graphNodes.id }).from(graphNodes);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = await db.select().from(graphEdges);
    for (const edge of edges) {
      expect(ids.has(edge.fromId), edge.id).toBe(true);
      expect(ids.has(edge.toId), edge.id).toBe(true);
    }
  });

  it('has no self-edges', async () => {
    const edges = await db.select().from(graphEdges);
    for (const edge of edges) expect(edge.fromId).not.toBe(edge.toId);
  });
});

describe('node keys', () => {
  it('slugs consistently, so one concept is one node', () => {
    expect(nodeKey('EtherNet/IP')).toBe(nodeKey('ethernet ip'));
    expect(nodeKey('Allen-Bradley')).toBe(nodeKey('allen bradley'));
    expect(nodeKey('  OPC UA  ')).toBe('opc-ua');
  });

  it('resolves a protocol spelled either way onto the same node', async () => {
    const a = await resolveNodes(['EtherNet/IP']);
    const b = await resolveNodes(['ethernet ip']);
    expect(a[0]?.id).toBeDefined();
    expect(a[0]?.id).toBe(b[0]?.id);
  });

  it('never resolves onto a product node', async () => {
    const nodes = await resolveNodes(['modbus', 'opc ua', 'rockwell']);
    for (const node of nodes) expect(node.kind).not.toBe('product');
  });
});

describe('walking to products', () => {
  it('reaches Allen-Bradley products from the word Rockwell', async () => {
    const hits = await graphSearch(['rockwell'], { limit: 10 });
    expect(hits.map((h) => h.sku)).toContain('TB-OPCUA-4100');
  });

  it('reaches Modbus products from the protocol', async () => {
    const hits = await graphSearch(['modbus'], { limit: 10 });
    expect(hits.length).toBeGreaterThan(3);
    expect(hits.some((h) => h.sku.startsWith('TB-GW-'))).toBe(true);
  });

  it('ranks a product connected to two named concepts above one connected to one', async () => {
    const hits = await graphSearch(['modbus', 'serial'], { limit: 10 });
    expect(hits[0]?.sku).toBe('TB-GW-5200');
  });

  it('explains the path it took', async () => {
    const hits = await graphSearch(['rockwell'], { limit: 3 });
    expect(hits[0]?.path).toContain('rockwell');
  });

  it('returns nothing for terms that are not in the graph', async () => {
    expect(await graphSearch(['flibbertigibbet'], { limit: 5 })).toEqual([]);
    expect(await graphSearch([], { limit: 5 })).toEqual([]);
  });

  it('honours the limit', async () => {
    expect((await graphSearch(['opc ua'], { limit: 4 })).length).toBeLessThanOrEqual(4);
  });

  it('scores every hit above zero and in descending order', async () => {
    const hits = await graphSearch(['modbus'], { limit: 8 });
    for (const hit of hits) expect(hit.score).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
  });
});

describe('the view queries', () => {
  it('lists nodes of a kind, most connected first', async () => {
    const nodes = await listNodesByKind('protocol', 10);
    expect(nodes.length).toBeGreaterThan(3);
    for (let i = 1; i < nodes.length; i += 1) {
      expect(nodes[i]!.degree).toBeLessThanOrEqual(nodes[i - 1]!.degree);
    }
  });

  it('finds a node by kind and key', async () => {
    const node = await findNode('protocol', nodeKey('Modbus TCP'));
    expect(node?.label).toBe('Modbus TCP');
  });

  it('returns null for a node that does not exist', async () => {
    expect(await findNode('protocol', 'no-such-protocol')).toBeNull();
  });

  it('returns a neighbourhood whose edges only reference its own nodes', async () => {
    const node = await findNode('protocol', nodeKey('Modbus TCP'));
    expect(node).not.toBeNull();
    const local = await neighbourhood(node?.id as string, 1);
    const ids = new Set(local.nodes.map((n) => n.id));
    expect(local.nodes.length).toBeGreaterThan(1);
    for (const edge of local.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it('includes the centre node in its own neighbourhood', async () => {
    const node = await findNode('vendor', nodeKey('Allen-Bradley'));
    const local = await neighbourhood(node?.id as string, 1);
    expect(local.nodes.map((n) => n.id)).toContain(node?.id);
  });
});
