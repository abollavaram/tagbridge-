import Link from 'next/link';
import type { GraphNodeKind, GraphRelation } from '@/lib/db/schema';
import {
  findNode,
  graphCounts,
  listNodesByKind,
  neighbourhood,
  type NeighbourhoodNode,
} from '@/lib/graph/walk';

export const metadata = {
  title: 'Knowledge graph',
  description:
    'The catalogue as a typed graph: which products speak which protocols, which vendors they are tested against, and what they write to.',
};
export const dynamic = 'force-dynamic';

const KIND_COLOR: Record<GraphNodeKind, string> = {
  product: 'var(--color-signal-500)',
  protocol: 'oklch(0.62 0.15 145)',
  vendor: 'oklch(0.65 0.16 60)',
  device: 'oklch(0.60 0.14 300)',
  concept: 'oklch(0.58 0.12 200)',
  destination: 'oklch(0.62 0.16 20)',
  category: 'oklch(0.55 0.03 250)',
};

const RELATION_LABEL: Record<GraphRelation, string> = {
  speaks: 'speaks',
  compatible_with: 'tested against',
  in_category: 'in category',
  alias_of: 'also called',
  writes_to: 'writes to',
  related_to: 'related to',
};

interface Point {
  x: number;
  y: number;
}

/**
 * Radial layout, computed on the server.
 *
 * A force simulation would need client JavaScript and would move on every
 * render, which makes a graph harder to read rather than easier. Fixed
 * positions mean the same neighbourhood always looks the same, the page needs
 * no JavaScript at all, and every node is a real link.
 */
function layout(centre: string, nodes: NeighbourhoodNode[]): Map<string, Point> {
  const positions = new Map<string, Point>();
  positions.set(centre, { x: 0, y: 0 });

  const others = nodes.filter((n) => n.id !== centre);
  const radius = others.length > 18 ? 250 : 190;
  others.forEach((node, index) => {
    const angle = (index / others.length) * Math.PI * 2 - Math.PI / 2;
    // Alternate radius slightly so labels on a crowded ring do not collide.
    const r = radius + (index % 2 === 0 ? 0 : 46);
    positions.set(node.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  });
  return positions;
}

function truncate(text: string, max = 26): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; key?: string }>;
}) {
  const params = await searchParams;
  const counts = await graphCounts();

  const kind = (params.kind ?? 'protocol') as GraphNodeKind;
  const entryPoints = await listNodesByKind(kind, 40);
  const selectedKey = params.key ?? entryPoints[0]?.key;
  const centre = selectedKey ? await findNode(kind, selectedKey) : null;

  const local = centre ? await neighbourhood(centre.id, 1) : { nodes: [], edges: [] };
  const positions = centre ? layout(centre.id, local.nodes) : new Map<string, Point>();
  const byId = new Map(local.nodes.map((n) => [n.id, n]));

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Knowledge graph</h1>
        <p className="max-w-3xl text-ink-700 dark:text-ink-300">
          The catalogue as typed nodes and edges rather than rows:{' '}
          <strong>{counts.nodes}</strong> nodes and <strong>{counts.edges}</strong> edges
          built from the products, their protocols and vendor compatibility, and the
          synonym table. This renders the real graph — the same one the search pipeline
          can walk — not a diagram of it.
        </p>
        <ul className="flex flex-wrap gap-2 text-xs">
          {counts.byKind.map((k) => (
            <li
              key={k.kind}
              className="flex items-center gap-1.5 rounded border border-ink-100 px-2 py-1 dark:border-ink-700"
            >
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-full"
                style={{ background: KIND_COLOR[k.kind] }}
              />
              {k.kind} <span className="tabular-nums text-ink-500">{k.count}</span>
            </li>
          ))}
        </ul>
      </header>

      <nav aria-label="Node kind" className="flex flex-wrap gap-2 text-sm">
        {(['protocol', 'vendor', 'concept', 'category', 'destination', 'device'] as const).map(
          (k) => (
            <Link
              key={k}
              href={`/graph?kind=${k}`}
              aria-current={k === kind ? 'page' : undefined}
              className={
                k === kind
                  ? 'rounded bg-signal-600 px-3 py-1 font-medium text-white'
                  : 'rounded border border-ink-300 px-3 py-1'
              }
            >
              {k}
            </Link>
          ),
        )}
      </nav>

      <div className="grid gap-8 md:grid-cols-[13rem_1fr]">
        <aside aria-labelledby="entry-points" className="space-y-2">
          <h2
            id="entry-points"
            className="text-xs font-semibold uppercase tracking-widest text-ink-500"
          >
            {kind}s
          </h2>
          <ul className="space-y-1 text-sm">
            {entryPoints.map((node) => (
              <li key={node.id}>
                <Link
                  href={`/graph?kind=${kind}&key=${encodeURIComponent(node.key)}`}
                  aria-current={node.key === selectedKey ? 'true' : undefined}
                  className={
                    node.key === selectedKey ? 'font-semibold underline' : 'hover:underline'
                  }
                >
                  {node.label}{' '}
                  <span className="tabular-nums text-ink-500">({node.degree})</span>
                </Link>
              </li>
            ))}
          </ul>
        </aside>

        <section aria-labelledby="graph-view" className="space-y-4">
          <h2 id="graph-view" className="text-xl font-semibold">
            {centre ? centre.label : 'Nothing selected'}
          </h2>

          {!centre ? (
            <p className="text-ink-500">Pick a node to see what it connects to.</p>
          ) : local.nodes.length <= 1 ? (
            <p className="text-ink-500">This node has no edges yet.</p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-lg border border-ink-100 dark:border-ink-700">
                <svg
                  viewBox="-340 -330 680 660"
                  className="h-auto w-full min-w-[34rem]"
                  role="img"
                  aria-label={`Nodes connected to ${centre.label}`}
                >
                  <g stroke="currentColor" className="text-ink-300" strokeWidth={1}>
                    {local.edges.map((edge) => {
                      const from = positions.get(edge.from);
                      const to = positions.get(edge.to);
                      if (!from || !to) return null;
                      return (
                        <line
                          key={`${edge.from}-${edge.to}-${edge.relation}`}
                          x1={from.x}
                          y1={from.y}
                          x2={to.x}
                          y2={to.y}
                          opacity={0.55}
                        />
                      );
                    })}
                  </g>

                  {local.nodes.map((node) => {
                    const point = positions.get(node.id);
                    if (!point) return null;
                    const isCentre = node.id === centre.id;
                    const href = `/graph?kind=${node.kind}&key=${encodeURIComponent(node.key)}`;
                    return (
                      <g key={node.id} transform={`translate(${point.x} ${point.y})`}>
                        <a href={href}>
                          <title>
                            {node.kind}: {node.label}
                          </title>
                          <circle
                            r={isCentre ? 13 : 7}
                            fill={KIND_COLOR[node.kind]}
                            stroke="currentColor"
                            strokeWidth={isCentre ? 2 : 0}
                            className="text-ink-900"
                          />
                          <text
                            y={isCentre ? -20 : -12}
                            textAnchor="middle"
                            fontSize={isCentre ? 15 : 11}
                            fontWeight={isCentre ? 600 : 400}
                            fill="currentColor"
                            className="text-ink-900 dark:text-ink-50"
                          >
                            {truncate(node.label, isCentre ? 40 : 22)}
                          </text>
                        </a>
                      </g>
                    );
                  })}
                </svg>
              </div>

              <details className="rounded-lg border border-ink-100 p-4 text-sm dark:border-ink-700">
                <summary className="cursor-pointer font-medium">
                  {local.edges.length} edges, as a list
                </summary>
                <ul className="mt-3 space-y-1">
                  {local.edges.map((edge) => {
                    const from = byId.get(edge.from);
                    const to = byId.get(edge.to);
                    if (!from || !to) return null;
                    return (
                      <li key={`${edge.from}-${edge.to}-${edge.relation}`}>
                        <span className="font-medium">{from.label}</span>
                        <span className="text-ink-500"> {RELATION_LABEL[edge.relation]} </span>
                        <span className="font-medium">{to.label}</span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
