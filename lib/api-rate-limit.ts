import { InProcessRateLimiter, type RateLimiter } from '@/lib/agent/guardrails';

/**
 * Rate limits for the public API surface.
 *
 * `/api/agent` was limited and `/api/search`, `/api/mcp` and the ACP endpoints
 * were not — and search runs two retrievers and a reranker per call, so it is
 * the most expensive unauthenticated thing here.
 *
 * One limiter per surface rather than one shared bucket: an agent hammering
 * MCP should not lock a human out of search. Same in-process caveat as the
 * agent's own limiter — this cannot coordinate across instances, and the
 * `RateLimiter` seam is where a Redis-backed one would go.
 */

const limiters: Record<string, RateLimiter> = {
  search: new InProcessRateLimiter(60, 60_000),
  mcp: new InProcessRateLimiter(120, 60_000),
  checkout: new InProcessRateLimiter(30, 60_000),
  ucp: new InProcessRateLimiter(60, 60_000),
};

/** The abuse case is one client hammering, signed in or not — so key on IP. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim();
  return ip && ip.length > 0 ? ip : 'unknown';
}

export interface RateVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function takeToken(surface: keyof typeof limiters, request: Request): RateVerdict {
  const limiter = limiters[surface];
  if (!limiter) return { allowed: true, retryAfterSeconds: 0 };
  const result = limiter.take(`${surface}:${clientKey(request)}`);
  return {
    allowed: result.allowed,
    retryAfterSeconds: Math.max(1, Math.ceil((result.resetAtMs - Date.now()) / 1000)),
  };
}

/** The 429 every limited route returns, so the shape is the same everywhere. */
export function tooManyRequests(verdict: RateVerdict): Response {
  return new Response(
    JSON.stringify({ error: 'too many requests', retryAfterSeconds: verdict.retryAfterSeconds }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(verdict.retryAfterSeconds),
      },
    },
  );
}

/** Test-only: clear every bucket between cases. */
export function resetApiRateLimits(): void {
  for (const limiter of Object.values(limiters)) {
    if (limiter instanceof InProcessRateLimiter) limiter.reset();
  }
}
