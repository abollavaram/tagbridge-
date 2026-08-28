/**
 * Reciprocal Rank Fusion.
 *
 * Combines ranked lists without needing their scores to be comparable, which
 * is exactly the situation here: BM25 returns `ts_rank` values and the vector
 * leg returns cosine distances, on entirely different scales. RRF only reads
 * positions, so nothing has to be calibrated.
 *
 *   score(d) = sum over lists of  weight / (k + rank(d))
 *
 * k = 60 is the value from Cormack et al. (2009) and the one the spec pins. It
 * flattens the contribution of the top few positions, so a document ranked 1st
 * by one retriever and 30th by another still beats one ranked 8th by a single
 * retriever and missing from the other.
 */

export const DEFAULT_RRF_K = 60;

export interface RankedItem {
  id: string;
  score: number;
}

export interface FusionInput {
  name: string;
  results: readonly RankedItem[];
  /** Relative influence of this list. Defaults to 1. */
  weight?: number;
}

export interface FusedItem {
  id: string;
  score: number;
  /** 1-based rank in each list that returned this item. */
  ranks: Record<string, number>;
}

export function reciprocalRankFusion(
  lists: readonly FusionInput[],
  k: number = DEFAULT_RRF_K,
): FusedItem[] {
  if (k <= 0) throw new Error(`RRF k must be positive, got ${k}`);

  const scores = new Map<string, number>();
  const ranks = new Map<string, Record<string, number>>();
  const firstSeen = new Map<string, number>();
  let order = 0;

  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.results.forEach((item, index) => {
      const rank = index + 1;
      scores.set(item.id, (scores.get(item.id) ?? 0) + weight / (k + rank));
      const existing = ranks.get(item.id) ?? {};
      existing[list.name] = rank;
      ranks.set(item.id, existing);
      if (!firstSeen.has(item.id)) firstSeen.set(item.id, order++);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: ranks.get(id) ?? {} }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable, deterministic tie-break: whichever the retrievers saw first.
      return (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0);
    });
}

/** Precision@k: what fraction of the first k results are relevant. */
export function precisionAt(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (k <= 0) return 0;
  const window = ranked.slice(0, k);
  if (window.length === 0) return 0;
  const hits = window.filter((id) => relevant.has(id)).length;
  return hits / k;
}

/** Recall@k: what fraction of the relevant set appears in the first k. */
export function recallAt(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  const window = new Set(ranked.slice(0, k));
  let found = 0;
  for (const id of relevant) if (window.has(id)) found += 1;
  return found / relevant.size;
}

/** Reciprocal rank of the first relevant result, or 0 if none appears. */
export function reciprocalRank(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
): number {
  for (let i = 0; i < ranked.length; i += 1) {
    if (relevant.has(ranked[i] as string)) return 1 / (i + 1);
  }
  return 0;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
