import { z } from 'zod';
import { MAX_LINE_QTY } from './pricing';

/**
 * Cart contents, carried in the cookie rather than in server memory.
 *
 * The deployment restores its database snapshot into each instance's own
 * memory, so a cart row written while serving one request is invisible to the
 * next request if it lands elsewhere. That showed up exactly as you would
 * expect from the outside: some items appear in the cart and some do not.
 *
 * Only quantities live here. Every price is still resolved server-side from
 * `price_tiers` on read, so a tampered cookie can change what a buyer is
 * asking for but never what it costs — the same guarantee the database-backed
 * cart gave, without depending on where the request lands.
 */

const MAX_LINES = 50;

const lineSchema = z
  .object({
    v: z.string().uuid(),
    q: z.number().int().min(1).max(MAX_LINE_QTY),
  })
  .strict();

const cartSchema = z.array(lineSchema).max(MAX_LINES);

export interface CartLineInput {
  variantId: string;
  qty: number;
}

/** Serialised form is deliberately terse: cookies have a 4 KB budget. */
export function encodeCart(lines: readonly CartLineInput[]): string {
  const payload = lines
    .slice(0, MAX_LINES)
    .map((line) => ({ v: line.variantId, q: line.qty }));
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cart cookie, returning an empty cart for anything malformed.
 *
 * A cookie is user-controlled input. Anything that does not parse is dropped
 * rather than repaired: a buyer with a corrupted cookie gets an empty cart,
 * which is recoverable, instead of an error page, which is not.
 */
export function decodeCart(raw: string | undefined): CartLineInput[] {
  if (!raw) return [];
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = cartSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return [];
    return dedupe(parsed.data.map((line) => ({ variantId: line.v, qty: line.q })));
  } catch {
    return [];
  }
}

/** One line per variant; a repeated variant has its quantities combined. */
function dedupe(lines: readonly CartLineInput[]): CartLineInput[] {
  const byVariant = new Map<string, number>();
  for (const line of lines) {
    byVariant.set(line.variantId, Math.min((byVariant.get(line.variantId) ?? 0) + line.qty, MAX_LINE_QTY));
  }
  return [...byVariant.entries()].map(([variantId, qty]) => ({ variantId, qty }));
}

export function addLine(
  lines: readonly CartLineInput[],
  variantId: string,
  qty: number,
): CartLineInput[] {
  if (!Number.isInteger(qty) || qty < 1) return [...lines];
  const existing = lines.find((l) => l.variantId === variantId);
  if (existing) {
    return lines.map((l) =>
      l.variantId === variantId
        ? { ...l, qty: Math.min(l.qty + qty, MAX_LINE_QTY) }
        : l,
    );
  }
  if (lines.length >= MAX_LINES) return [...lines];
  return [...lines, { variantId, qty: Math.min(qty, MAX_LINE_QTY) }];
}

export function setLineQty(
  lines: readonly CartLineInput[],
  variantId: string,
  qty: number,
): CartLineInput[] {
  if (qty <= 0) return removeLine(lines, variantId);
  if (!Number.isInteger(qty)) return [...lines];
  return lines.map((l) =>
    l.variantId === variantId ? { ...l, qty: Math.min(qty, MAX_LINE_QTY) } : l,
  );
}

export function removeLine(
  lines: readonly CartLineInput[],
  variantId: string,
): CartLineInput[] {
  return lines.filter((l) => l.variantId !== variantId);
}

export const CART_COOKIE = 'tb_cart';
export const CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
export const MAX_CART_LINES = MAX_LINES;
