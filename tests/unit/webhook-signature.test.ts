import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  signPayload,
  verifySignature,
} from '@/lib/sync/signature';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
const NOW_MS = 1_760_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

function header(payload = BODY, secret = SECRET, timestamp = NOW_S): string {
  return signPayload(payload, secret, timestamp);
}

describe('webhook signature verification', () => {
  it('accepts a signature it just produced', () => {
    const result = verifySignature(BODY, header(), SECRET, { nowMs: NOW_MS });
    expect(result).toEqual({ ok: true, timestamp: NOW_S });
  });

  it('refuses a request with no signature header at all', () => {
    expect(verifySignature(BODY, null, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'missing_header',
    });
  });

  it('refuses a header with no timestamp', () => {
    const digest = createHmac('sha256', SECRET).update(`${NOW_S}.${BODY}`).digest('hex');
    expect(verifySignature(BODY, `v1=${digest}`, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('refuses a non-numeric timestamp rather than reading it as stale', () => {
    expect(verifySignature(BODY, `t=yesterday,v1=abcd`, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('refuses a header carrying a timestamp but no signature', () => {
    expect(verifySignature(BODY, `t=${NOW_S}`, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'no_signatures',
    });
  });

  it('refuses a signature made with a different secret', () => {
    const forged = header(BODY, 'whsec_wrong');
    expect(verifySignature(BODY, forged, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses when the body changed after signing, byte for byte', () => {
    const signed = header();
    const tampered = BODY.replace('evt_1', 'evt_2');
    expect(verifySignature(tampered, signed, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses a body that only differs by whitespace, which is why raw bytes are used', () => {
    const signed = header();
    // Re-serialising a parsed body produces exactly this class of difference.
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifySignature(reserialised, signed, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('accepts a signature at the edge of the tolerance window', () => {
    const old = NOW_S - DEFAULT_TOLERANCE_SECONDS;
    expect(verifySignature(BODY, header(BODY, SECRET, old), SECRET, { nowMs: NOW_MS }).ok).toBe(
      true,
    );
  });

  it('refuses a replay from just outside the window', () => {
    const old = NOW_S - DEFAULT_TOLERANCE_SECONDS - 1;
    expect(verifySignature(BODY, header(BODY, SECRET, old), SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    });
  });

  it('refuses a timestamp far in the future as well as far in the past', () => {
    const ahead = NOW_S + DEFAULT_TOLERANCE_SECONDS + 1;
    expect(verifySignature(BODY, header(BODY, SECRET, ahead), SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    });
  });

  it('accepts when one of several signatures matches, as during a secret rotation', () => {
    const good = createHmac('sha256', SECRET).update(`${NOW_S}.${BODY}`).digest('hex');
    const old = createHmac('sha256', 'whsec_previous').update(`${NOW_S}.${BODY}`).digest('hex');
    const combined = `t=${NOW_S},v1=${old},v1=${good}`;
    expect(verifySignature(BODY, combined, SECRET, { nowMs: NOW_MS }).ok).toBe(true);
  });

  it('refuses a signature of the wrong length without throwing', () => {
    expect(verifySignature(BODY, `t=${NOW_S},v1=abc123`, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses a non-hex signature without throwing', () => {
    expect(verifySignature(BODY, `t=${NOW_S},v1=zzzz`, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('refuses an empty signature value', () => {
    expect(verifySignature(BODY, `t=${NOW_S},v1=`, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('tolerates whitespace around the header parts', () => {
    const digest = createHmac('sha256', SECRET).update(`${NOW_S}.${BODY}`).digest('hex');
    expect(verifySignature(BODY, ` t=${NOW_S} , v1=${digest} `, SECRET, { nowMs: NOW_MS }).ok).toBe(
      true,
    );
  });

  it('signs the timestamp alongside the body, so the two cannot be mixed and matched', () => {
    const signed = signPayload(BODY, SECRET, NOW_S);
    const digest = signed.split('v1=')[1];
    // Same digest, different claimed timestamp: the digest no longer verifies.
    const swapped = `t=${NOW_S - 10},v1=${digest}`;
    expect(verifySignature(BODY, swapped, SECRET, { nowMs: NOW_MS })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    });
  });
});
