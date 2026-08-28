import { NextResponse } from 'next/server';
import { z } from 'zod';
import { search } from '@/lib/search/pipeline';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().min(1).max(200),
  mode: z
    .enum(['bm25-naive', 'bm25', 'bm25-expanded', 'vector', 'hybrid', 'hybrid-rerank'])
    .default('hybrid-rerank'),
  limit: z.coerce.number().int().min(1).max(25).default(8),
});

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    q: url.searchParams.get('q') ?? '',
    mode: url.searchParams.get('mode') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid query', issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const log = requestLogger(requestIdFrom(request.headers));
  const result = await search(parsed.data.q, {
    mode: parsed.data.mode,
    limit: parsed.data.limit,
  });

  log.info(
    { mode: result.mode, hits: result.hits.length, tookMs: Math.round(result.tookMs) },
    'search',
  );

  return NextResponse.json({
    query: result.query,
    intent: result.intent,
    mode: result.mode,
    expandedTerms: result.expandedTerms,
    tookMs: Math.round(result.tookMs * 10) / 10,
    hits: result.hits.map((h) => ({
      sku: h.sku,
      name: h.name,
      slug: h.slug,
      category: h.category,
      score: Math.round(h.score * 1000) / 1000,
      reasons: h.reasons,
    })),
  });
}
