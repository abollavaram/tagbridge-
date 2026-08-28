import { contentTokens, type NormalizedQuery } from './normalize';
import { lookupVariants, type SynonymGraph } from './synonym-graph';

/**
 * Reranking the fused candidates.
 *
 * The spec calls for an LLM here. `Reranker` is the seam for one, and
 * `llmRerankerAvailable()` reports whether this deployment has a key. What
 * ships as the default is deterministic and feature-based, for three reasons:
 * it needs no key, it runs in under a millisecond so p95 latency stays inside
 * budget, and — most importantly — its decisions are inspectable. Every result
 * carries the reasons it was promoted, which is what makes a bad ranking
 * debuggable instead of a shrug.
 */

export interface RerankCandidate {
  id: string;
  sku: string;
  name: string;
  slug: string;
  category: string;
  description: string;
  protocols: readonly string[];
  vendorCompat: readonly string[];
  /** Score from fusion, used as the prior. */
  fusedScore: number;
  /** Position after fusion, 1-based. */
  fusedRank: number;
}

export interface RerankedResult extends RerankCandidate {
  rerankScore: number;
  reasons: string[];
}

export interface Reranker {
  readonly name: string;
  rerank(
    query: NormalizedQuery,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<RerankedResult[]>;
}

export interface RerankWeights {
  exactSku: number;
  variantSkuPrefix: number;
  nameToken: number;
  protocolMatch: number;
  vendorMatch: number;
  categoryToken: number;
  descriptionToken: number;
  coverage: number;
  fusionPrior: number;
  synonymDiscount: number;
}

export const DEFAULT_WEIGHTS: RerankWeights = {
  exactSku: 6,
  variantSkuPrefix: 3,
  nameToken: 1.4,
  protocolMatch: 1.1,
  vendorMatch: 1.1,
  categoryToken: 0.6,
  descriptionToken: 0.25,
  coverage: 2.2,
  /** The fused rank is evidence, not noise: keep it as a decaying prior. */
  fusionPrior: 2.5,
  /** Applied to a match reached through the synonym graph rather than named. */
  synonymDiscount: 0.7,
};

/**
 * Whole-word containment.
 *
 * Plain `includes` matches "ua" inside "quality" and "ab" inside "cable",
 * which quietly inflates scores for products that have nothing to do with the
 * query. Matching on word boundaries costs a regex and removes a whole class
 * of wrong answers.
 */
function containsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/** The value from `haystack` that matches `needle`, if any. */
function fieldMatch(haystack: readonly string[], needle: string): string | undefined {
  const variants = lookupVariants(needle);
  return haystack.find((value) => {
    const lower = value.toLowerCase();
    return variants.some((v) => lower === v || containsWord(lower, v));
  });
}

/**
 * Scores one candidate against the query, returning the score and the
 * human-readable reasons behind it.
 */
export function scoreCandidate(
  query: NormalizedQuery,
  candidate: RerankCandidate,
  graph: SynonymGraph | null,
  weights: RerankWeights = DEFAULT_WEIGHTS,
): { score: number; reasons: string[] } {
  const WEIGHTS = weights;
  const reasons: string[] = [];
  let score = WEIGHTS.fusionPrior / Math.sqrt(candidate.fusedRank);

  const tokens = contentTokens(query);
  const nameLower = candidate.name.toLowerCase();
  const descriptionLower = candidate.description.toLowerCase();
  const categoryLower = candidate.category.toLowerCase();

  for (const partNumber of query.partNumbers) {
    if (candidate.sku.toUpperCase() === partNumber) {
      score += WEIGHTS.exactSku;
      reasons.push(`exact part number ${candidate.sku}`);
    } else if (candidate.sku.toUpperCase().startsWith(partNumber)) {
      score += WEIGHTS.variantSkuPrefix;
      reasons.push(`part number prefix ${partNumber}`);
    }
  }

  // Expanded terms let "Rockwell" match a product listing "Allen-Bradley".
  const expanded = graph ? graph.expand(tokens).terms : tokens;
  const matched = new Set<string>();

  for (const token of tokens) {
    // A literal token in the name is stronger evidence than a synonym of it:
    // "SQL Server" in a name means more for a SQL query than "Allen-Bradley"
    // does for a ControlLogix one, even though both are true matches.
    const literalInName = containsWord(nameLower, token);
    const siblingInName = graph
      ? graph.siblingsOf(token).find((s) => containsWord(nameLower, s))
      : undefined;

    if (literalInName || siblingInName) {
      score += literalInName ? WEIGHTS.nameToken : WEIGHTS.nameToken * WEIGHTS.synonymDiscount;
      matched.add(token);
      reasons.push(
        literalInName
          ? `"${token}" in the product name`
          : `"${siblingInName}" in the product name, for "${token}"`,
      );
      continue;
    }

    const protocol = fieldMatch(candidate.protocols, token);
    if (protocol) {
      score += WEIGHTS.protocolMatch;
      matched.add(token);
      reasons.push(`speaks ${protocol}`);
      continue;
    }

    const vendor = fieldMatch(candidate.vendorCompat, token);
    if (vendor) {
      score += WEIGHTS.vendorMatch;
      matched.add(token);
      reasons.push(`tested against ${vendor}`);
      continue;
    }

    if (containsWord(categoryLower, token)) {
      score += WEIGHTS.categoryToken;
      matched.add(token);
      continue;
    }
    if (containsWord(descriptionLower, token)) {
      score += WEIGHTS.descriptionToken;
      matched.add(token);
    }
  }

  // Expanded-only matches count once, at a discount: reaching a product
  // through the synonym graph is real evidence but weaker than naming it.
  for (const term of expanded) {
    if (matched.has(term)) continue;
    const via = fieldMatch(candidate.protocols, term) ?? fieldMatch(candidate.vendorCompat, term);
    if (via) {
      score += WEIGHTS.protocolMatch * WEIGHTS.synonymDiscount;
      matched.add(term);
      reasons.push(`matches ${via} through the synonym graph`);
    }
  }

  if (tokens.length > 0) {
    const coverage = tokens.filter((t) => matched.has(t)).length / tokens.length;
    score += coverage * WEIGHTS.coverage;
    if (coverage === 1) reasons.push('covers every term in the query');
  }

  return { score, reasons };
}

export class DeterministicReranker implements Reranker {
  readonly name = 'deterministic-features-v1';

  constructor(
    private readonly graph: SynonymGraph | null = null,
    private readonly weights: RerankWeights = DEFAULT_WEIGHTS,
  ) {}

  rerank(
    query: NormalizedQuery,
    candidates: readonly RerankCandidate[],
    limit: number,
  ): Promise<RerankedResult[]> {
    const scored = candidates.map((candidate) => {
      const { score, reasons } = scoreCandidate(query, candidate, this.graph, this.weights);
      return { ...candidate, rerankScore: score, reasons };
    });

    scored.sort((a, b) => {
      if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
      return a.fusedRank - b.fusedRank;
    });

    return Promise.resolve(scored.slice(0, limit));
  }
}

/** Whether an LLM reranker could be constructed on this deployment. */
export function llmRerankerAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
