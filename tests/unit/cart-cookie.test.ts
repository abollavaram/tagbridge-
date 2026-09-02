import { describe, expect, it } from 'vitest';
import {
  addLine,
  decodeCart,
  encodeCart,
  MAX_CART_LINES,
  removeLine,
  setLineQty,
  type CartLineInput,
} from '@/lib/commerce/cart-cookie';
import { MAX_LINE_QTY } from '@/lib/commerce/pricing';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('round trip', () => {
  it('survives encoding and decoding unchanged', () => {
    const lines: CartLineInput[] = [
      { variantId: A, qty: 3 },
      { variantId: B, qty: 1 },
    ];
    expect(decodeCart(encodeCart(lines))).toEqual(lines);
  });

  it('encodes to something cookie-safe', () => {
    const encoded = encodeCart([{ variantId: A, qty: 1 }]);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('stays inside a sensible cookie budget when full', () => {
    const lines = Array.from({ length: MAX_CART_LINES }, () => ({ variantId: A, qty: 9999 }));
    expect(encodeCart(lines).length).toBeLessThan(4096);
  });

  it('treats an absent cookie as an empty cart', () => {
    expect(decodeCart(undefined)).toEqual([]);
    expect(decodeCart('')).toEqual([]);
  });
});

describe('a cookie is user-controlled input', () => {
  it('drops anything that is not valid base64 JSON', () => {
    for (const raw of ['not-base64!!', 'YWJj', '{}', 'eyJhIjoxfQ']) {
      expect(decodeCart(raw), raw).toEqual([]);
    }
  });

  it('drops a line whose variant id is not a uuid', () => {
    const forged = Buffer.from(JSON.stringify([{ v: 'DROP TABLE carts', q: 1 }]))
      .toString('base64url');
    expect(decodeCart(forged)).toEqual([]);
  });

  it('drops a forged quantity rather than honouring it', () => {
    for (const q of [0, -5, 1.5, 1e9]) {
      const forged = Buffer.from(JSON.stringify([{ v: A, q }])).toString('base64url');
      expect(decodeCart(forged), `${q}`).toEqual([]);
    }
  });

  it('drops a cookie carrying an extra field, which is how a price would arrive', () => {
    const forged = Buffer.from(
      JSON.stringify([{ v: A, q: 1, unitPriceCents: 1 }]),
    ).toString('base64url');
    expect(decodeCart(forged)).toEqual([]);
  });

  it('refuses a cart longer than the cap', () => {
    const tooMany = Array.from({ length: MAX_CART_LINES + 1 }, () => ({ v: A, q: 1 }));
    const forged = Buffer.from(JSON.stringify(tooMany)).toString('base64url');
    expect(decodeCart(forged)).toEqual([]);
  });

  it('combines a repeated variant instead of showing it twice', () => {
    const forged = Buffer.from(
      JSON.stringify([{ v: A, q: 2 }, { v: A, q: 3 }]),
    ).toString('base64url');
    expect(decodeCart(forged)).toEqual([{ variantId: A, qty: 5 }]);
  });
});

describe('mutations', () => {
  it('adds a new line', () => {
    expect(addLine([], A, 2)).toEqual([{ variantId: A, qty: 2 }]);
  });

  it('accumulates onto an existing line', () => {
    expect(addLine([{ variantId: A, qty: 2 }], A, 3)).toEqual([{ variantId: A, qty: 5 }]);
  });

  it('never exceeds the maximum quantity', () => {
    const result = addLine([{ variantId: A, qty: MAX_LINE_QTY }], A, 10);
    expect(result[0]?.qty).toBe(MAX_LINE_QTY);
  });

  it('ignores an invalid quantity rather than corrupting the cart', () => {
    for (const qty of [0, -1, 2.5]) {
      expect(addLine([{ variantId: A, qty: 1 }], A, qty), `${qty}`)
        .toEqual([{ variantId: A, qty: 1 }]);
    }
  });

  it('refuses to grow past the line cap', () => {
    const full: CartLineInput[] = Array.from({ length: MAX_CART_LINES }, (_, i) => ({
      variantId: `${i}`.padStart(8, '0') + '-1111-4111-8111-111111111111',
      qty: 1,
    }));
    expect(addLine(full, A, 1)).toHaveLength(MAX_CART_LINES);
  });

  it('sets a quantity outright', () => {
    expect(setLineQty([{ variantId: A, qty: 2 }], A, 9)).toEqual([{ variantId: A, qty: 9 }]);
  });

  it('removes a line when the quantity drops to zero or below', () => {
    expect(setLineQty([{ variantId: A, qty: 2 }], A, 0)).toEqual([]);
    expect(setLineQty([{ variantId: A, qty: 2 }], A, -3)).toEqual([]);
  });

  it('removes a line on request and leaves the others', () => {
    const lines = [{ variantId: A, qty: 1 }, { variantId: B, qty: 2 }];
    expect(removeLine(lines, A)).toEqual([{ variantId: B, qty: 2 }]);
  });

  it('is a no-op when removing something not in the cart', () => {
    const lines = [{ variantId: A, qty: 1 }];
    expect(removeLine(lines, B)).toEqual(lines);
  });

  it('never mutates the input array', () => {
    const lines: CartLineInput[] = [{ variantId: A, qty: 1 }];
    addLine(lines, B, 1);
    setLineQty(lines, A, 5);
    removeLine(lines, A);
    expect(lines).toEqual([{ variantId: A, qty: 1 }]);
  });
});

describe('the cart carries no prices at all', () => {
  it('encodes only variant ids and quantities', () => {
    const encoded = encodeCart([{ variantId: A, qty: 3 }]);
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    expect(json).toBe(JSON.stringify([{ v: A, q: 3 }]));
    expect(json.toLowerCase()).not.toContain('price');
    expect(json.toLowerCase()).not.toContain('cent');
  });
});
