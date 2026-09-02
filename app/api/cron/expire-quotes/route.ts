import { NextResponse } from 'next/server';
import { isScheduler } from '@/lib/cron-auth';
import { expireOverdueQuotes } from '@/lib/commerce/expiry';
import { requestIdFrom, requestLogger } from '@/lib/telemetry/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Walks the `expired` edges the state machine has always had. */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isScheduler(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const log = requestLogger(requestIdFrom(request.headers));
  const report = await expireOverdueQuotes();

  log.info(
    { considered: report.considered, expired: report.expired, tookMs: report.tookMs },
    'quote expiry',
  );

  return NextResponse.json({
    ranAt: report.ranAt.toISOString(),
    considered: report.considered,
    expired: report.expired,
    skipped: report.skipped,
    tookMs: report.tookMs,
  });
}
