import { inArray } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { SEED_SYNONYMS } from '@/lib/db/synonyms';
import { products } from '@/lib/db/schema';
import { getEmbedder, type Embedder } from './embedding';
import { DEFAULT_RRF_K, reciprocalRankFusion, type FusionInput } from './fusion';
import { classifyIntent, type Intent, type IntentResult } from './intent';
import { normalizeQuery, type NormalizedQuery } from './normalize';
import { DeterministicReranker, type RerankCandidate, type RerankedResult, type Reranker } from './rerank';
import { bm25Search, naiveBm25Search, partNumberSearch, vectorSearch } from './retrievers';
import { SynonymGraph } from './synonym-graph';

/**
 * The search pipeline.
 *
 *   normalise -> synonym expansion -> BM25 + dense (in parallel)
 *             -> reciprocal rank fusion -> rerank -> intent
 *
 * `mode` exists so the evaluation can run each stage in isolation against the
 * same golden set. That is the whole point of the eval table: showing what
 * each stage is worth, rather than asserting that the assembled thing is good.
 */

/**
 * `bm25` is the honest baseline: stock Postgres full-text search over the raw
 * query, with no synonym expansion and no part-number handling — what a
 * catalogue gets out of the box. `bm25-expanded` isolates what the synonym
 * layer alone contributes, which turns out to be most of the gain.
 */
export type SearchMode =
  | 'bm25-naive'
  | 'bm25'
  | 'bm25-expanded'
  | 'vector'
  | 'hybrid'
  | 'hybrid-rerank';

const SINGLE_LEG: ReadonlySet<SearchMode> = new Set([
  'bm25-naive',
  'bm25',
  'bm25-expanded',
  'vector',
]);

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  /** How many candidates each leg contributes before fusion. */
  candidates?: number;
  rrfK?: number;
}

export interface SearchHit {
  id: string;
  sku: string;
  name: string;
  slug: string;
  category: string;
  score: number;
  reasons: string[];
}

export interface SearchResponse {
  query: string;
  normalized: NormalizedQuery;
  expandedTerms: string[];
  intent: IntentResult;
  mode: SearchMode;
  hits: SearchHit[];
  tookMs: number;
}

let graphPromise: Promise<SynonymGraph> | null = null;

/**
 * The synonym graph, loaded from the database so that edits to the table take
 * effect without a redeploy, falling back to the seed definitions when the
 * table has not been populated yet.
 */
export async function getSynonymGraph(): Promise<SynonymGraph> {
  if (graphPromise) return graphPromise;
  graphPromise = (async () => {
    try {
      const db = await getDatabase();
      const { synonyms } = await import('@/lib/db/schema');
      const rows = await db
        .select({ term: synonyms.term, canonical: synonyms.canonical, kind: synonyms.kind })
        .from(synonyms);
      if (rows.length > 0) return SynonymGraph.fromRows(rows);
    } catch {
      // Fall through to the seed definitions.
    }
    return new SynonymGraph(SEED_SYNONYMS);
  })();
  return graphPromise;
}

export function resetSynonymGraph(): void {
  graphPromise = null;
}

async function loadCandidates(
  ids: readonly string[],
): Promise<Map<string, Omit<RerankCandidate, 'fusedScore' | 'fusedRank'>>> {
  const map = new Map<string, Omit<RerankCandidate, 'fusedScore' | 'fusedRank'>>();
  if (ids.length === 0) return map;

  const db = await getDatabase();
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      slug: products.slug,
      category: products.category,
      description: products.description,
      protocols: products.protocols,
      vendorCompat: products.vendorCompat,
    })
    .from(products)
    .where(inArray(products.id, [...ids]));

  for (const row of rows) map.set(row.id, row);
  return map;
}

export interface SearchDependencies {
  embedder?: Embedder;
  graph?: SynonymGraph;
  reranker?: Reranker;
}

/** Deduplicates reasons while keeping the first occurrence of each. */
function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}

export async function search(
  rawQuery: string,
  options: SearchOptions = {},
  deps: SearchDependencies = {},
): Promise<SearchResponse> {
  const started = performance.now();
  const mode = options.mode ?? 'hybrid-rerank';
  const limit = options.limit ?? 8;
  const candidateCount = options.candidates ?? 20;

  const normalized = normalizeQuery(rawQuery);
  const graph = deps.graph ?? (await getSynonymGraph());
  const expansion = graph.expand(normalized.tokens);
  const intent = classifyIntent(normalized, graph);

  if (normalized.tokens.length === 0) {
    return {
      query: rawQuery,
      normalized,
      expandedTerms: [],
      intent,
      mode,
      hits: [],
      tookMs: performance.now() - started,
    };
  }

  const needsLexical = mode !== 'vector';
  const needsDense = mode !== 'bm25' && mode !== 'bm25-expanded' && mode !== 'bm25-naive';
  // Neither baseline gets the synonym layer or exact part-number lookup.
  const usesExpansion = mode !== 'bm25' && mode !== 'bm25-naive';
  const lexicalTerms = usesExpansion ? expansion.terms : normalized.tokens;

  const embedder = needsDense ? deps.embedder ?? (await getEmbedder()) : null;

  const [lexical, dense, exact] = await Promise.all([
    needsLexical
      ? mode === 'bm25-naive'
        ? naiveBm25Search(normalized.tokens, candidateCount)
        : bm25Search(lexicalTerms, candidateCount)
      : Promise.resolve([]),
    needsDense && embedder
      ? embedder.embed(normalized.text).then((v) => vectorSearch(v, candidateCount))
      : Promise.resolve([]),
    needsLexical && usesExpansion
      ? partNumberSearch(normalized.partNumbers, Math.min(candidateCount, 10))
      : Promise.resolve([]),
  ]);

  // Single-leg modes report that leg directly, so the eval measures the
  // retriever rather than the fusion of one list with itself.
  if (SINGLE_LEG.has(mode)) {
    const source = mode === 'vector' ? dense : mergeExact(exact, lexical);
    const detail = await loadCandidates(source.map((r) => r.id));
    return {
      query: rawQuery,
      normalized,
      expandedTerms: usesExpansion ? expansion.terms : normalized.tokens,
      intent,
      mode,
      hits: source.slice(0, limit).map((row) => ({
        id: row.id,
        sku: row.sku,
        name: row.name,
        slug: row.slug,
        category: detail.get(row.id)?.category ?? '',
        score: row.score,
        reasons: [],
      })),
      tookMs: performance.now() - started,
    };
  }

  // Intent-weighted fusion. The classifier already knows what shape of
  // question this is, and the two legs are good at different shapes: a part
  // number is a lexical problem, a described symptom is a semantic one.
  // Weighting by intent costs nothing and uses a signal already computed.
  const legWeights = fusionWeightsFor(intent.intent);

  const lists: FusionInput[] = [
    { name: 'bm25', results: lexical, weight: legWeights.lexical },
    { name: 'vector', results: dense, weight: legWeights.dense },
  ];
  // Exact part-number hits join the fusion as their own list rather than
  // being spliced on top, so agreement with the other legs still counts.
  if (exact.length > 0) lists.push({ name: 'part-number', results: exact, weight: 1.5 });

  const fused = reciprocalRankFusion(lists, options.rrfK ?? DEFAULT_RRF_K);
  const topFused = fused.slice(0, candidateCount);
  const detail = await loadCandidates(topFused.map((f) => f.id));

  if (mode === 'hybrid') {
    return {
      query: rawQuery,
      normalized,
      expandedTerms: expansion.terms,
      intent,
      mode,
      hits: topFused.slice(0, limit).flatMap((f) => {
        const d = detail.get(f.id);
        if (!d) return [];
        return [{
          id: d.id,
          sku: d.sku,
          name: d.name,
          slug: d.slug,
          category: d.category,
          score: f.score,
          reasons: [],
        }];
      }),
      tookMs: performance.now() - started,
    };
  }

  const candidates: RerankCandidate[] = topFused.flatMap((f, index) => {
    const d = detail.get(f.id);
    if (!d) return [];
    return [{ ...d, fusedScore: f.score, fusedRank: index + 1 }];
  });

  const reranker = deps.reranker ?? new DeterministicReranker(graph);
  const reranked: RerankedResult[] = await reranker.rerank(normalized, candidates, limit);

  return {
    query: rawQuery,
    normalized,
    expandedTerms: expansion.terms,
    intent,
    mode,
    hits: reranked.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      slug: r.slug,
      category: r.category,
      score: r.rerankScore,
      reasons: uniqueReasons(r.reasons),
    })),
    tookMs: performance.now() - started,
  };
}

/**
 * How much each leg is trusted for a given intent.
 *
 * These are ratios, not tuned constants: a named product is a lexical problem,
 * a described symptom is a semantic one, and a compatibility question sits
 * between the two because it names technology but asks about behaviour.
 */
export function fusionWeightsFor(intent: Intent): { lexical: number; dense: number } {
  switch (intent) {
    case 'specific-product':
      return { lexical: 1.4, dense: 0.8 };
    case 'browse':
      return { lexical: 0.8, dense: 1.4 };
    case 'compatibility-question':
      return { lexical: 1, dense: 1 };
  }
}

/** Exact part-number hits first, then lexical, without duplicates. */
function mergeExact<T extends { id: string }>(exact: readonly T[], rest: readonly T[]): T[] {
  const seen = new Set(exact.map((e) => e.id));
  return [...exact, ...rest.filter((r) => !seen.has(r.id))];
}
