/**
 * The search evaluation.
 *
 * Runs the golden set through each stage of the pipeline in isolation and
 * prints the comparison table. `pnpm eval:search` fails the build when the
 * thresholds in SPEC.md are missed, so the number in the README cannot drift
 * away from the number the code actually produces.
 *
 * On precision@3: a part-number query has exactly one correct answer, so
 * plain precision@3 caps at 0.33 for it however perfect the ranking. The
 * metric here is therefore normalised by the number of answers available —
 * hits divided by min(3, |relevant|) — which is 1.0 when a system puts every
 * available answer in the top three. This is stated in the printed output and
 * in the README rather than left for a reader to discover.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { getDatabase } from '@/lib/db';
import { products } from '@/lib/db/schema';
import { mean, recallAt, reciprocalRank } from '@/lib/search/fusion';
import { search, type SearchMode } from '@/lib/search/pipeline';
import { BUCKETS, GOLDEN_QUERIES, type Bucket, type GoldenQuery } from './golden';

const MODES: { mode: SearchMode; label: string }[] = [
  { mode: 'bm25-naive', label: 'BM25 naive' },
  { mode: 'bm25', label: 'BM25 only' },
  { mode: 'bm25-expanded', label: 'BM25 + synonyms' },
  { mode: 'vector', label: 'Vector only' },
  { mode: 'hybrid', label: 'Hybrid (RRF)' },
  { mode: 'hybrid-rerank', label: 'Hybrid + rerank' },
];

const THRESHOLDS = {
  precisionAt3: 0.85,
  liftOverBm25: 0.15,
  p95LatencyMs: 400,
};

export function normalisedPrecisionAt(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  const attainable = Math.min(k, relevant.size);
  if (attainable === 0) return 0;
  const hits = ranked.slice(0, k).filter((id) => relevant.has(id)).length;
  return hits / attainable;
}

export interface ModeMetrics {
  label: string;
  mode: SearchMode;
  precisionAt3: number;
  recallAt5: number;
  mrr: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  perBucket: Record<Bucket, number>;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

async function skuToId(): Promise<Map<string, string>> {
  const db = await getDatabase();
  const rows = await db
    .select({ id: products.id, sku: products.sku })
    .from(products)
    .where(eq(products.active, true));
  return new Map(rows.map((r) => [r.sku, r.id]));
}

export async function evaluateMode(
  mode: SearchMode,
  label: string,
  queries: readonly GoldenQuery[],
  ids: ReadonlyMap<string, string>,
): Promise<ModeMetrics> {
  const precisions: number[] = [];
  const recalls: number[] = [];
  const rrs: number[] = [];
  const latencies: number[] = [];
  const byBucket = new Map<Bucket, number[]>();

  for (const golden of queries) {
    const relevant = new Set(
      golden.relevant.flatMap((sku) => {
        const id = ids.get(sku);
        return id ? [id] : [];
      }),
    );

    const started = performance.now();
    const response = await search(golden.query, { mode, limit: 8 });
    latencies.push(performance.now() - started);

    const ranked = response.hits.map((h) => h.id);
    const precision = normalisedPrecisionAt(ranked, relevant, 3);

    precisions.push(precision);
    recalls.push(recallAt(ranked, relevant, 5));
    rrs.push(reciprocalRank(ranked, relevant));

    const bucket = byBucket.get(golden.bucket) ?? [];
    bucket.push(precision);
    byBucket.set(golden.bucket, bucket);
  }

  const perBucket = Object.fromEntries(
    BUCKETS.map((b) => [b, mean(byBucket.get(b) ?? [])]),
  ) as Record<Bucket, number>;

  return {
    label,
    mode,
    precisionAt3: mean(precisions),
    recallAt5: mean(recalls),
    mrr: mean(rrs),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    perBucket,
  };
}

function fmt(value: number): string {
  return value.toFixed(2);
}

function pad(text: string, width: number): string {
  return text.padEnd(width, ' ');
}

async function main(): Promise<void> {
  const ids = await skuToId();
  if (ids.size === 0) {
    throw new Error('No products in the database. Run `pnpm db:setup` first.');
  }

  const results: ModeMetrics[] = [];
  for (const { mode, label } of MODES) {
    results.push(await evaluateMode(mode, label, GOLDEN_QUERIES, ids));
  }

  console.log(`\nSearch evaluation — ${GOLDEN_QUERIES.length} queries, ${ids.size} products\n`);
  console.log(`${pad('', 18)}precision@3   recall@5   MRR`);
  for (const r of results) {
    console.log(
      `${pad(r.label, 18)}${pad(fmt(r.precisionAt3), 14)}${pad(fmt(r.recallAt5), 11)}${fmt(r.mrr)}`,
    );
  }

  console.log(`\nprecision@3 by bucket\n`);
  console.log(`${pad('', 18)}${BUCKETS.map((b) => pad(b, 17)).join('')}`);
  for (const r of results) {
    console.log(
      `${pad(r.label, 18)}${BUCKETS.map((b) => pad(fmt(r.perBucket[b]), 17)).join('')}`,
    );
  }

  console.log(`\nlatency (ms)\n`);
  console.log(`${pad('', 18)}p50        p95`);
  for (const r of results) {
    console.log(
      `${pad(r.label, 18)}${pad(r.p50LatencyMs.toFixed(1), 11)}${r.p95LatencyMs.toFixed(1)}`,
    );
  }

  console.log(
    '\nprecision@3 is normalised by the answers available: hits / min(3, relevant).',
  );
  console.log('A part-number query has one correct answer, so plain precision@3 would');
  console.log('cap at 0.33 for it however perfect the ranking.\n');

  const naive = results.find((r) => r.mode === 'bm25-naive');
  const bm25 = results.find((r) => r.mode === 'bm25');
  const best = results.find((r) => r.mode === 'hybrid-rerank');
  if (!naive || !bm25 || !best) throw new Error('missing a mode in the results');

  // Reported against both baselines, because they answer different questions.
  // The naive row is what a default full-text setup gives you and is what the
  // incumbent storefront actually is. The weighted row shares this project's
  // schema and index, so it is the conservative comparison and the one the
  // threshold is checked against.
  const liftOverNaive = best.precisionAt3 - naive.precisionAt3;
  const lift = best.precisionAt3 - bm25.precisionAt3;
  const failures: string[] = [];

  if (best.precisionAt3 < THRESHOLDS.precisionAt3) {
    failures.push(
      `precision@3 ${fmt(best.precisionAt3)} < ${THRESHOLDS.precisionAt3} required`,
    );
  }
  if (lift < THRESHOLDS.liftOverBm25) {
    failures.push(
      `lift over the weighted BM25 baseline ${fmt(lift)} < ${THRESHOLDS.liftOverBm25} required ` +
        `(lift over the naive baseline is ${fmt(liftOverNaive)})`,
    );
  }
  if (best.p95LatencyMs > THRESHOLDS.p95LatencyMs) {
    failures.push(
      `p95 latency ${best.p95LatencyMs.toFixed(0)}ms > ${THRESHOLDS.p95LatencyMs}ms budget`,
    );
  }

  console.log(
    `hybrid + rerank beats the naive baseline by ${fmt(liftOverNaive)} on precision@3,`,
  );
  console.log(
    `and the weighted BM25 baseline by ${fmt(lift)}. The threshold is checked`,
  );
  console.log('against the weighted baseline, which is the harder comparison.');

  if (failures.length > 0) {
    console.error(`\nFAIL:\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
  }
  console.log('\nAll thresholds met.\n');
  process.exit(0);
}

if (process.argv[1]?.endsWith('run.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
