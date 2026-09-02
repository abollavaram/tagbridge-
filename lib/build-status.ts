/**
 * What is actually built.
 *
 * This exists because a hardcoded "Phase 2" sat on the home page for three
 * phases after it stopped being true. A number typed into a page is a claim
 * nobody re-reads; a number imported from here is one place to change, and
 * a test asserts the pages agree with it.
 *
 * Phases are the spec's own, and `shipped` means the acceptance criteria were
 * measured and met — not that the code exists.
 */

export interface Phase {
  number: number;
  name: string;
  shipped: boolean;
  /** What a visitor can go and look at. */
  proof: string;
}

export const PHASES: readonly Phase[] = [
  { number: 0, name: 'Foundation', shipped: true, proof: '/api/health' },
  { number: 1, name: 'Catalog and cart', shipped: true, proof: '/products' },
  { number: 2, name: 'Search', shipped: true, proof: '/search' },
  { number: 3, name: 'Quotes and agent', shipped: true, proof: '/approvals' },
  { number: 4, name: 'Subscription sync', shipped: true, proof: '/admin/sync' },
  { number: 5, name: 'Agent-native layer', shipped: true, proof: '/.well-known/ucp' },
];

export const PHASES_SHIPPED = PHASES.filter((p) => p.shipped).length;
export const PHASES_TOTAL = PHASES.length;

/** Measured, not estimated. Every figure here comes from a run that is in the repo. */
export const MEASURED = {
  /** evals/search — precision@3 over the 100-query golden set. */
  searchPrecisionAt3: 0.89,
  searchRecallAt5: 0.92,
  searchQueries: 100,
  /** evals/agent — 30 scenarios, 20 ordinary and 10 adversarial. */
  agentScenarios: 30,
  guardrailHoldRate: 1.0,
  /** vitest + playwright. */
  tests: 711,
} as const;
