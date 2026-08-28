import { createHash } from 'node:crypto';
import { SynonymGraph } from './synonym-graph';
import { normalizeQuery } from './normalize';

/**
 * Text embedding.
 *
 * `Embedder` is the seam. A hosted model (Voyage, OpenAI) drops in behind it
 * without anything else changing; what ships here is a local, deterministic
 * embedder that needs no API key, no network and no cost, so the evaluation is
 * reproducible on any machine including CI.
 *
 * It is not a language model and does not pretend to be. It earns its place in
 * the hybrid by encoding three things BM25 cannot:
 *
 *   1. Character n-grams, so "modbis gateway" still lands near "modbus".
 *   2. Synonym canonicalisation, so "Rockwell" and "Allen-Bradley" project
 *      onto the same coordinates rather than merely both existing.
 *   3. Sub-linear term weighting, so a term repeated in a long description
 *      does not dominate a short, precise product name.
 *
 * Where a hosted model would beat it is genuine paraphrase — "won't talk to"
 * meaning "cannot communicate". The eval table reports that honestly.
 */

export const EMBEDDING_DIMENSIONS = 1536;

export interface Embedder {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: readonly string[]): Promise<number[][]>;
}

/** Stable 32-bit hash. Deterministic across processes and machines. */
function hashToBucket(token: string, salt: string, buckets: number): number {
  const digest = createHash('sha1').update(`${salt}:${token}`).digest();
  const value = digest.readUInt32BE(0);
  return value % buckets;
}

/** Signed hashing keeps unrelated collisions from always accumulating. */
function hashSign(token: string, salt: string): number {
  return createHash('sha1').update(`${salt}#${token}`).digest()[0]! % 2 === 0 ? 1 : -1;
}

function characterNgrams(text: string, size: number): string[] {
  const padded = ` ${text} `;
  const grams: string[] = [];
  for (let i = 0; i + size <= padded.length; i += 1) {
    grams.push(padded.slice(i, i + size));
  }
  return grams;
}

export interface HashingEmbedderOptions {
  dimensions?: number;
  /** Weight applied to whole-token features relative to character n-grams. */
  tokenWeight?: number;
  ngramWeight?: number;
  /** Weight applied to the canonical form a term expands to. */
  canonicalWeight?: number;
  ngramSizes?: number[];
}

export class HashingEmbedder implements Embedder {
  readonly name = 'local-hashing-v1';
  readonly dimensions: number;

  private readonly graph: SynonymGraph | null;
  private readonly tokenWeight: number;
  private readonly ngramWeight: number;
  private readonly canonicalWeight: number;
  private readonly ngramSizes: number[];

  constructor(graph: SynonymGraph | null = null, options: HashingEmbedderOptions = {}) {
    this.graph = graph;
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
    this.tokenWeight = options.tokenWeight ?? 1;
    this.ngramWeight = options.ngramWeight ?? 0.35;
    this.canonicalWeight = options.canonicalWeight ?? 0.9;
    this.ngramSizes = options.ngramSizes ?? [3, 4];
  }

  private accumulate(vector: Float64Array, feature: string, salt: string, weight: number): void {
    const bucket = hashToBucket(feature, salt, this.dimensions);
    vector[bucket] = (vector[bucket] ?? 0) + weight * hashSign(feature, salt);
  }

  embedSync(text: string): number[] {
    const vector = new Float64Array(this.dimensions);
    const normalized = normalizeQuery(text);
    const tokens = normalized.tokens;

    // Sub-linear term frequency: the tenth mention of "tag" is not ten times
    // the evidence of the first.
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    for (const [token, count] of counts) {
      const tf = 1 + Math.log(count);
      this.accumulate(vector, token, 'tok', this.tokenWeight * tf);

      for (const size of this.ngramSizes) {
        for (const gram of characterNgrams(token, size)) {
          this.accumulate(vector, gram, `ng${size}`, this.ngramWeight * tf);
        }
      }
    }

    // Canonical forms, so vendor and protocol aliases share coordinates.
    if (this.graph) {
      const expansion = this.graph.expand(tokens);
      for (const canonical of expansion.canonicals) {
        this.accumulate(vector, canonical, 'canon', this.canonicalWeight);
        for (const gram of characterNgrams(canonical, 4)) {
          this.accumulate(vector, gram, 'ng4', this.ngramWeight * 0.5);
        }
      }
    }

    return l2Normalize(vector);
  }

  embed(text: string): Promise<number[]> {
    return Promise.resolve(this.embedSync(text));
  }

  embedBatch(texts: readonly string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.embedSync(t)));
  }
}

export function l2Normalize(vector: Float64Array | number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const magnitude = Math.sqrt(sumOfSquares);
  const out = new Array<number>(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    out[i] = magnitude === 0 ? 0 : (vector[i] as number) / magnitude;
  }
  return out;
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

let cached: Embedder | null = null;

/** The embedder the app and the evaluation both use. */
export async function getEmbedder(): Promise<Embedder> {
  if (cached) return cached;
  const { SEED_SYNONYMS } = await import('@/lib/db/synonyms');
  cached = new HashingEmbedder(new SynonymGraph(SEED_SYNONYMS));
  return cached;
}

export function resetEmbedder(): void {
  cached = null;
}
