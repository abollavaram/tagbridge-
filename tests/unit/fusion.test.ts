import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RRF_K,
  mean,
  precisionAt,
  recallAt,
  reciprocalRank,
  reciprocalRankFusion,
} from '@/lib/search/fusion';

function list(name: string, ids: string[]) {
  return { name, results: ids.map((id, i) => ({ id, score: 1 - i / 100 })) };
}

describe('reciprocal rank fusion', () => {
  it('uses the k the spec pins', () => {
    expect(DEFAULT_RRF_K).toBe(60);
  });

  it('ranks a document agreed on by both retrievers above either list alone', () => {
    const fused = reciprocalRankFusion([
      list('bm25', ['a', 'b', 'c']),
      list('vector', ['c', 'a', 'd']),
    ]);
    expect(fused[0]?.id).toBe('a');
  });

  it('combines lists that share nothing', () => {
    const fused = reciprocalRankFusion([list('bm25', ['a']), list('vector', ['b'])]);
    expect(fused.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('ignores incomparable score scales, reading only position', () => {
    const bm25 = { name: 'bm25', results: [{ id: 'x', score: 999 }, { id: 'y', score: 998 }] };
    const vector = { name: 'vector', results: [{ id: 'y', score: 0.02 }, { id: 'x', score: 0.01 }] };
    const fused = reciprocalRankFusion([bm25, vector]);
    // Both rank 1 and rank 2 once, so the scores tie exactly.
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0, 12);
  });

  it('rewards broad agreement over one strong opinion', () => {
    const fused = reciprocalRankFusion([
      list('a', ['solo', 'shared']),
      list('b', ['x', 'shared']),
      list('c', ['y', 'shared']),
    ]);
    expect(fused[0]?.id).toBe('shared');
  });

  it('records the rank each list gave an item', () => {
    const fused = reciprocalRankFusion([
      list('bm25', ['a', 'b']),
      list('vector', ['b', 'a']),
    ]);
    const a = fused.find((f) => f.id === 'a');
    expect(a?.ranks).toEqual({ bm25: 1, vector: 2 });
  });

  it('applies a weight to a list', () => {
    const unweighted = reciprocalRankFusion([
      { ...list('bm25', ['a']), weight: 1 },
      { ...list('vector', ['b']), weight: 1 },
    ]);
    expect(unweighted[0]?.score).toBeCloseTo(unweighted[1]?.score ?? 0, 12);

    const weighted = reciprocalRankFusion([
      { ...list('bm25', ['a']), weight: 3 },
      { ...list('vector', ['b']), weight: 1 },
    ]);
    expect(weighted[0]?.id).toBe('a');
  });

  it('is stable and deterministic on ties', () => {
    const input = [list('a', ['p', 'q']), list('b', ['q', 'p'])];
    const first = reciprocalRankFusion(input).map((f) => f.id);
    const second = reciprocalRankFusion(input).map((f) => f.id);
    expect(first).toEqual(second);
  });

  it('handles empty input and empty lists', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([list('bm25', [])])).toEqual([]);
  });

  it('refuses a non-positive k rather than dividing by zero', () => {
    expect(() => reciprocalRankFusion([list('a', ['x'])], 0)).toThrow(/must be positive/);
    expect(() => reciprocalRankFusion([list('a', ['x'])], -1)).toThrow(/must be positive/);
  });

  it('gives a smaller k a sharper preference for rank 1', () => {
    const lists = [list('a', ['first', 'second']), list('b', ['second', 'first'])];
    const flat = reciprocalRankFusion(lists, 60);
    const sharp = reciprocalRankFusion(lists, 1);
    const spread = (f: { score: number }[]) => (f[0]?.score ?? 0) - (f[1]?.score ?? 0);
    expect(Math.abs(spread(sharp))).toBeGreaterThanOrEqual(Math.abs(spread(flat)));
  });
});

describe('evaluation metrics', () => {
  const relevant = new Set(['a', 'b']);

  it('computes precision@k against the window size, not the hit count', () => {
    expect(precisionAt(['a', 'x', 'y'], relevant, 3)).toBeCloseTo(1 / 3, 10);
    expect(precisionAt(['a', 'b', 'y'], relevant, 3)).toBeCloseTo(2 / 3, 10);
    expect(precisionAt(['x', 'y', 'z'], relevant, 3)).toBe(0);
  });

  it('computes recall@k against the relevant set size', () => {
    expect(recallAt(['a', 'x', 'y', 'z', 'w'], relevant, 5)).toBe(0.5);
    expect(recallAt(['a', 'b', 'y', 'z', 'w'], relevant, 5)).toBe(1);
    expect(recallAt(['x', 'y'], relevant, 5)).toBe(0);
  });

  it('reports reciprocal rank of the first hit', () => {
    expect(reciprocalRank(['a'], relevant)).toBe(1);
    expect(reciprocalRank(['x', 'b'], relevant)).toBe(0.5);
    expect(reciprocalRank(['x', 'y', 'z', 'a'], relevant)).toBeCloseTo(0.25, 10);
    expect(reciprocalRank(['x', 'y'], relevant)).toBe(0);
  });

  it('returns zero rather than NaN on empty inputs', () => {
    expect(precisionAt([], relevant, 3)).toBe(0);
    expect(recallAt(['a'], new Set(), 3)).toBe(0);
    expect(mean([])).toBe(0);
  });

  it('averages correctly', () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5, 10);
  });
});
