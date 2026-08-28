import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface CheckResult {
  ok: boolean;
  detail?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    const db = await getDatabase();
    await db.execute(sql`select 1`);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'unknown error' };
  }
}

/** Configured-or-not, reported honestly. Phases 1 and 3 make these live calls. */
function checkConfigured(name: string, value: string | undefined): CheckResult {
  return value ? { ok: true } : { ok: false, detail: `${name} not configured` };
}

export async function GET(request: Request): Promise<NextResponse> {
  const log = requestLogger(requestIdFrom(request.headers));
  const database = await checkDatabase();
  const stripe = checkConfigured('STRIPE_SECRET_KEY', process.env.STRIPE_SECRET_KEY);
  const llm = checkConfigured('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY);

  // Only the database is load-bearing at this phase; Stripe and the LLM
  // provider are reported but do not fail the check until they are wired in.
  const status = database.ok ? 'ok' : 'degraded';
  if (!database.ok) log.error({ database }, 'health check failed');

  return NextResponse.json(
    {
      status,
      checks: { database, stripe, llm },
      version: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
      time: new Date().toISOString(),
    },
    { status: database.ok ? 200 : 503 },
  );
}
