import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/lib/db';
import { graphEdges, graphNodes, products } from '@/lib/db/schema';
import type { GraphNodeKind, GraphRelation } from '@/lib/db/schema';
import { SEED_SYNONYMS } from '@/lib/db/synonyms';

/**
 * Builds the knowledge graph from the catalogue and the synonym table.
 *
 * Nothing here is new information — it is the same facts the catalogue
 * already holds, restructured so they can be traversed. That is the point:
 * a flat alias list answers "what else is this called", a graph answers
 * "what reaches what, and through how many hops".
 *
 * Weights say how much a hop is trusted. An alias is near-lossless (100); a
 * product speaking a protocol is strong evidence (90); sharing a category is
 * weak (40), because two products in the same category are often alternatives
 * rather than companions.
 */

const WEIGHTS: Record<GraphRelation, number> = {
  alias_of: 100,
  speaks: 90,
  compatible_with: 85,
  writes_to: 80,
  related_to: 60,
  in_category: 40,
};

/** Node keys are slugs so that "EtherNet/IP" and "ethernet/ip" are one node. */
export function nodeKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Destinations a connector writes to, inferred from its vendor list. */
const DESTINATION_HINTS: Record<string, string> = {
  'microsoft sql server': 'SQL Server',
  'azure sql': 'SQL Server',
  postgresql: 'PostgreSQL',
  timescaledb: 'PostgreSQL',
  influxdb: 'InfluxDB',
  telegraf: 'InfluxDB',
  snowflake: 'Snowflake',
  'aws s3': 'Snowflake',
  'azure blob storage': 'Snowflake',
  'aws iot core': 'MQTT broker',
  'azure iot hub': 'MQTT broker',
  mosquitto: 'MQTT broker',
  hivemq: 'MQTT broker',
  ignition: 'SCADA',
  'generic scada': 'SCADA',
  'generic hmi': 'SCADA',
};

export interface GraphBuildResult {
  nodes: number;
  edges: number;
  byKind: Record<string, number>;
  byRelation: Record<string, number>;
}

export async function buildKnowledgeGraph(db: AppDatabase): Promise<GraphBuildResult> {
  // Rebuilt from scratch each time: the graph is derived data, and a stale
  // edge is harder to notice than a missing one.
  await db.delete(graphEdges);
  await db.delete(graphNodes);

  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      category: products.category,
      protocols: products.protocols,
      vendorCompat: products.vendorCompat,
    })
    .from(products)
    .where(eq(products.active, true));

  interface PendingNode {
    kind: GraphNodeKind;
    key: string;
    label: string;
    productId: string | null;
  }
  const pendingNodes = new Map<string, PendingNode>();
  const pendingEdges = new Map<string, { from: string; to: string; relation: GraphRelation }>();

  const addNode = (
    kind: GraphNodeKind,
    label: string,
    productId: string | null = null,
  ): string => {
    const key = nodeKey(label);
    const composite = `${kind}:${key}`;
    if (!pendingNodes.has(composite)) {
      pendingNodes.set(composite, { kind, key, label, productId });
    }
    return composite;
  };

  const addEdge = (from: string, to: string, relation: GraphRelation): void => {
    if (from === to) return;
    pendingEdges.set(`${from}|${to}|${relation}`, { from, to, relation });
  };

  for (const product of rows) {
    const productNode = addNode('product', product.sku, product.id);
    // Keep the readable name on the node rather than the SKU alone.
    const entry = pendingNodes.get(productNode);
    if (entry) entry.label = product.name;

    const categoryNode = addNode('category', product.category);
    addEdge(productNode, categoryNode, 'in_category');

    for (const protocol of product.protocols) {
      addEdge(productNode, addNode('protocol', protocol), 'speaks');
    }

    for (const vendor of product.vendorCompat) {
      addEdge(productNode, addNode('vendor', vendor), 'compatible_with');
      const destination = DESTINATION_HINTS[vendor.toLowerCase()];
      if (destination) {
        addEdge(productNode, addNode('destination', destination), 'writes_to');
      }
    }
  }

  // Alias edges from the synonym table, both directions, so a walk starting
  // from either spelling reaches the other.
  for (const synonym of SEED_SYNONYMS) {
    const kind: GraphNodeKind =
      synonym.kind === 'protocol'
        ? 'protocol'
        : synonym.kind === 'vendor'
          ? 'vendor'
          : synonym.kind === 'device'
            ? 'device'
            : 'concept';
    const termNode = addNode(kind, synonym.term);
    const canonicalNode = addNode(kind, synonym.canonical);
    addEdge(termNode, canonicalNode, 'alias_of');
    addEdge(canonicalNode, termNode, 'alias_of');
  }

  const nodeList = [...pendingNodes.entries()];
  const insertedIds = new Map<string, string>();

  for (let i = 0; i < nodeList.length; i += 200) {
    const chunk = nodeList.slice(i, i + 200);
    const inserted = await db
      .insert(graphNodes)
      .values(
        chunk.map(([, node]) => ({
          kind: node.kind,
          key: node.key,
          label: node.label,
          productId: node.productId,
        })),
      )
      .returning({ id: graphNodes.id, kind: graphNodes.kind, key: graphNodes.key });
    for (const row of inserted) insertedIds.set(`${row.kind}:${row.key}`, row.id);
  }

  const edgeValues = [...pendingEdges.values()].flatMap((edge) => {
    const fromId = insertedIds.get(edge.from);
    const toId = insertedIds.get(edge.to);
    if (!fromId || !toId) return [];
    return [{ fromId, toId, relation: edge.relation, weight: WEIGHTS[edge.relation] }];
  });

  for (let i = 0; i < edgeValues.length; i += 300) {
    await db.insert(graphEdges).values(edgeValues.slice(i, i + 300));
  }

  const byKind: Record<string, number> = {};
  for (const [, node] of nodeList) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  const byRelation: Record<string, number> = {};
  for (const edge of edgeValues) {
    byRelation[edge.relation] = (byRelation[edge.relation] ?? 0) + 1;
  }

  return { nodes: nodeList.length, edges: edgeValues.length, byKind, byRelation };
}
