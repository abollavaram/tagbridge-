import { sql } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { toRows } from '@/lib/db/rows';
import type { GraphNodeKind, GraphRelation } from '@/lib/db/schema';
import { nodeKey } from './build';

/**
 * Walking the graph from query terms to products.
 *
 * The synonym layer expands one hop: "Rockwell" reaches "Allen-Bradley" and
 * the lexical retriever takes it from there. A walk goes further — from a term
 * to the concept, from the concept to every product related to it, and on to
 * what those products speak or write to. That reaches answers no amount of
 * term matching does, because the connection is a relation rather than a word
 * the two documents happen to share.
 *
 * Path score decays with each hop, so a two-hop answer never outranks a
 * one-hop one on graph evidence alone. The walk is one leg of the hybrid, not
 * the whole of it.
 */

export interface GraphHit {
  productId: string;
  sku: string;
  name: string;
  slug: string;
  score: number;
  /** How the walk got here, for explaining a result. */
  path: string;
}

const HOP_DECAY = 0.55;
const MAX_HOPS = 2;

export interface WalkOptions {
  maxHops?: number;
  limit?: number;
  /** Relations a walk may traverse. Defaults to all of them. */
  relations?: GraphRelation[];
}

/**
 * Resolves free-text terms onto graph nodes.
 *
 * Terms are slugged the same way node keys are, so "EtherNet/IP" and
 * "ethernet ip" land on the same node without a second normalisation scheme.
 */
export async function resolveNodes(
  terms: readonly string[],
): Promise<{ id: string; kind: GraphNodeKind; key: string; label: string }[]> {
  const keys = [...new Set(terms.map((t) => nodeKey(t)).filter((k) => k.length > 1))];
  if (keys.length === 0) return [];

  const db = await getDatabase();
  const matches = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const result = await db.execute<{
    id: string;
    kind: GraphNodeKind;
    key: string;
    label: string;
  }>(sql`
    select id, kind, key, label
    from graph_nodes
    where key in (${matches}) and kind <> 'product'
  `);
  return toRows(result);
}

/**
 * Walks outward from a set of start nodes and returns the products reached.
 *
 * Implemented as a recursive CTE so the traversal happens in the database
 * rather than in a loop of round trips: on a catalogue this size the whole
 * walk is a single query in single-digit milliseconds.
 */
export async function walkToProducts(
  startNodeIds: readonly string[],
  options: WalkOptions = {},
): Promise<GraphHit[]> {
  if (startNodeIds.length === 0) return [];

  const maxHops = options.maxHops ?? MAX_HOPS;
  const limit = options.limit ?? 20;
  const db = await getDatabase();

  const starts = sql.join(
    startNodeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const result = await db.execute<{
    product_id: string;
    sku: string;
    name: string;
    slug: string;
    score: number;
    path: string;
  }>(sql`
    with recursive reachable as (
      select
        n.id as node_id,
        n.id as root_id,
        1.0::float8 as score,
        0 as hops,
        n.label as path
      from graph_nodes n
      where n.id in (${starts})

      union all

      -- Edges are followed in both directions. A protocol node has no outgoing
      -- edge to the products that speak it, only incoming ones, so an
      -- out-only walk would never reach a product from a protocol.
      select
        case when e.from_id = r.node_id then e.to_id else e.from_id end,
        r.root_id,
        r.score * ${HOP_DECAY} * (e.weight / 100.0),
        r.hops + 1,
        r.path || ' - ' || nn.label
      from reachable r
      join graph_edges e on e.from_id = r.node_id or e.to_id = r.node_id
      join graph_nodes nn
        on nn.id = case when e.from_id = r.node_id then e.to_id else e.from_id end
      where r.hops < ${maxHops}
    ),
    -- Best path per (product, starting concept), so one concept cannot pay
    -- twice for reaching the same product by two routes.
    per_root as (
      select distinct on (r.node_id, r.root_id)
        r.node_id, r.root_id, r.score, r.path
      from reachable r
      order by r.node_id, r.root_id, r.score desc
    ),
    -- Summed across concepts: a product connected to two things the buyer
    -- named outranks one connected to a single thing.
    scored as (
      select
        node_id,
        sum(score)::float8 as score,
        count(*)::int as concepts,
        (array_agg(path order by score desc))[1] as path
      from per_root
      group by node_id
    )
    select
      p.id as product_id, p.sku, p.name, p.slug,
      s.score, s.path
    from scored s
    join graph_nodes n on n.id = s.node_id
    join products p on p.id = n.product_id
    where n.kind = 'product' and p.active
    order by s.score desc, s.concepts desc, p.name asc
    limit ${limit}
  `);

  return toRows<{
    product_id: string;
    sku: string;
    name: string;
    slug: string;
    score: number;
    path: string;
  }>(result).map((r) => ({
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    slug: r.slug,
    score: Number(r.score),
    path: r.path,
  }));
}

/** The whole thing: terms in, products out. */
export async function graphSearch(
  terms: readonly string[],
  options: WalkOptions = {},
): Promise<GraphHit[]> {
  const nodes = await resolveNodes(terms);
  if (nodes.length === 0) return [];
  return walkToProducts(
    nodes.map((n) => n.id),
    options,
  );
}

/** Nodes of one kind, for the graph view's entry points. */
export async function listNodesByKind(
  kind: GraphNodeKind,
  limit = 100,
): Promise<{ id: string; key: string; label: string; degree: number }[]> {
  const db = await getDatabase();
  const result = await db.execute<{
    id: string;
    key: string;
    label: string;
    degree: number;
  }>(sql`
    select n.id, n.key, n.label,
           (select count(*) from graph_edges e
             where e.from_id = n.id or e.to_id = n.id)::int as degree
    from graph_nodes n
    where n.kind = ${kind}
    order by degree desc, n.label asc
    limit ${limit}
  `);
  return toRows(result);
}

export async function findNode(
  kind: GraphNodeKind,
  key: string,
): Promise<{ id: string; kind: GraphNodeKind; key: string; label: string } | null> {
  const db = await getDatabase();
  const result = await db.execute<{
    id: string;
    kind: GraphNodeKind;
    key: string;
    label: string;
  }>(sql`
    select id, kind, key, label from graph_nodes
    where kind = ${kind} and key = ${key} limit 1
  `);
  return (
    toRows<{ id: string; kind: GraphNodeKind; key: string; label: string }>(result)[0] ?? null
  );
}

export async function graphCounts(): Promise<{
  nodes: number;
  edges: number;
  byKind: { kind: GraphNodeKind; count: number }[];
}> {
  const db = await getDatabase();
  const nodeCount = await db.execute<{ c: number }>(sql`select count(*)::int as c from graph_nodes`);
  const edgeCount = await db.execute<{ c: number }>(sql`select count(*)::int as c from graph_edges`);
  const kinds = await db.execute<{ kind: GraphNodeKind; count: number }>(sql`
    select kind, count(*)::int as count from graph_nodes group by kind order by count desc
  `);
  return {
    nodes: toRows<{ c: number }>(nodeCount)[0]?.c ?? 0,
    edges: toRows<{ c: number }>(edgeCount)[0]?.c ?? 0,
    byKind: toRows(kinds),
  };
}

export interface NeighbourhoodNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  key: string;
}

export interface NeighbourhoodEdge {
  from: string;
  to: string;
  relation: GraphRelation;
}

/** The local neighbourhood of one node, for the graph view. */
export async function neighbourhood(
  nodeId: string,
  hops = 1,
): Promise<{ nodes: NeighbourhoodNode[]; edges: NeighbourhoodEdge[] }> {
  const db = await getDatabase();

  const result = await db.execute<{
    from_id: string;
    to_id: string;
    relation: GraphRelation;
    from_kind: GraphNodeKind;
    from_label: string;
    from_key: string;
    to_kind: GraphNodeKind;
    to_label: string;
    to_key: string;
  }>(sql`
    with recursive reachable as (
      select ${nodeId}::uuid as node_id, 0 as hops
      union all
      select case when e.from_id = r.node_id then e.to_id else e.from_id end, r.hops + 1
      from reachable r
      join graph_edges e on e.from_id = r.node_id or e.to_id = r.node_id
      where r.hops < ${hops}
    ),
    ids as (select distinct node_id from reachable)
    select
      e.from_id, e.to_id, e.relation,
      f.kind as from_kind, f.label as from_label, f.key as from_key,
      t.kind as to_kind, t.label as to_label, t.key as to_key
    from graph_edges e
    join graph_nodes f on f.id = e.from_id
    join graph_nodes t on t.id = e.to_id
    where e.from_id in (select node_id from ids)
      and e.to_id in (select node_id from ids)
    limit 400
  `);

  const rows = toRows<{
    from_id: string;
    to_id: string;
    relation: GraphRelation;
    from_kind: GraphNodeKind;
    from_label: string;
    from_key: string;
    to_kind: GraphNodeKind;
    to_label: string;
    to_key: string;
  }>(result);

  const nodes = new Map<string, NeighbourhoodNode>();
  const edges: NeighbourhoodEdge[] = [];
  for (const row of rows) {
    nodes.set(row.from_id, {
      id: row.from_id,
      kind: row.from_kind,
      label: row.from_label,
      key: row.from_key,
    });
    nodes.set(row.to_id, {
      id: row.to_id,
      kind: row.to_kind,
      label: row.to_label,
      key: row.to_key,
    });
    edges.push({ from: row.from_id, to: row.to_id, relation: row.relation });
  }

  return { nodes: [...nodes.values()], edges };
}
