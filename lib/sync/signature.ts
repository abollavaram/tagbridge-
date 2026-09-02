import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature verification.
 *
 * Implements the scheme Stripe uses: a `t=` timestamp and one or more `v1=`
 * HMAC-SHA256 signatures over `${timestamp}.${rawBody}`, sent in a single
 * header. Written out here rather than pulled from the Stripe SDK for two
 * reasons — it is the part worth being able to test directly, and it keeps
 * the webhook route working against the simulated provider when no Stripe
 * key is configured.
 *
 * Three properties matter and each is a separate failure mode:
 *
 *  - The body must be the *raw* bytes. Parsing to JSON and re-serialising
 *    changes key order and whitespace, and the signature stops matching for
 *    reasons that look like a key mismatch. The route reads `request.text()`
 *    before anything else touches the body.
 *  - The comparison must be constant-time. A `===` on a hex digest leaks the
 *    digest a byte at a time to anyone who can measure the response.
 *  - The timestamp must be inside a tolerance. Without it a signature stays
 *    valid forever, and a captured request can be replayed indefinitely.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'no_signatures'
  | 'timestamp_outside_tolerance'
  | 'signature_mismatch';

export type VerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: SignatureFailure };

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') {
      // A non-numeric or fractional timestamp is malformed, not merely stale.
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (timestamp === null) return null;
  return { timestamp, signatures };
}

export function signPayload(payload: string, secret: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** Constant-time hex comparison that tolerates unequal lengths. */
function digestsMatch(expected: string, candidate: string): boolean {
  if (!/^[0-9a-f]+$/i.test(candidate)) return false;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(candidate.toLowerCase(), 'hex');
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal. Compare against a same-length buffer and fold the length
  // check into the result instead.
  const sameLength = a.length === b.length;
  const probe = sameLength ? b : a;
  const equal = timingSafeEqual(a, probe);
  return sameLength && equal;
}

export function verifySignature(
  payload: string,
  header: string | null,
  secret: string,
  options: { toleranceSeconds?: number; nowMs?: number } = {},
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_header' };

  const parsed = parseHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed_header' };
  if (parsed.signatures.length === 0) return { ok: false, reason: 'no_signatures' };

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  // Absolute difference: a timestamp far in the future is as suspect as a
  // stale one, and clock skew cuts both ways.
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_outside_tolerance' };
  }

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${payload}`)
    .digest('hex');

  // Every candidate is checked even after one matches, so the number of
  // comparisons does not depend on which signature was the right one. Stripe
  // sends more than one during a secret rotation.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (digestsMatch(expected, candidate)) matched = true;
  }

  return matched
    ? { ok: true, timestamp: parsed.timestamp }
    : { ok: false, reason: 'signature_mismatch' };
}
