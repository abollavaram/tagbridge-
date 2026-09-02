import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a request is the scheduler.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set
 * on the project. Constant-time, and when no secret is configured the endpoint
 * is refused outright rather than left open — an unprotected endpoint that
 * walks the whole quote or event table is a free amplification primitive for
 * anyone who finds the URL.
 *
 * The one exception is a non-production build, where there is no secret to
 * configure and the e2e suite needs to call it.
 */
export function isScheduler(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';

  const header = request.headers.get('authorization') ?? '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const presented = Buffer.from(header);
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}
