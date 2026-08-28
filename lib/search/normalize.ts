/**
 * Query normalisation.
 *
 * Two things must survive this step, and they pull in opposite directions: a
 * part number like `TB-OPCUA-4100` has to stay intact and matchable, while
 * prose like "Modbus device will not talk to my SCADA" needs punctuation
 * stripped and case flattened. Part-number-shaped tokens are therefore
 * detected first and carried through untouched.
 */

/** Letter/digit groups joined by hyphens, containing at least one digit. */
const PART_NUMBER = /\b[a-z]+(?:-[a-z0-9]+)*-?\d[a-z0-9]*(?:-[a-z0-9]+)*\b/gi;

/** Protocol spellings that must not be split on their own punctuation. */
const PROTECTED_TOKENS = [
  'ethernet/ip',
  'bacnet/ip',
  'bacnet ms/tp',
  'ms/tp',
  'opc ua a&c',
  'opc a&e',
  'rs-232',
  'rs-485',
  'iec 61850',
  'cc-link ie',
  'cc-link',
  'sparkplug b',
  'allen-bradley',
  'store-and-forward',
];

export interface NormalizedQuery {
  /** Lower-cased, punctuation-stripped text for lexical and dense matching. */
  text: string;
  /** Individual terms, in order, with protected forms kept whole. */
  tokens: string[];
  /** Part-number-shaped tokens, upper-cased, in the order they appeared. */
  partNumbers: string[];
  /** The query exactly as it was typed. */
  raw: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does',
  'for', 'from', 'get', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it',
  'its', 'me', 'my', 'need', 'of', 'on', 'or', 'our', 'that', 'the', 'their',
  'then', 'there', 'this', 'to', 'want', 'was', 'we', 'what', 'when', 'which',
  'will', 'with', 'would', 'you', 'your',
]);

export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token);
}

/** Looks like a catalogue part number rather than an ordinary word. */
export function looksLikePartNumber(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length < 3) return false;
  if (!/\d/.test(trimmed)) return false;
  if (!/[a-z]/i.test(trimmed)) return false;
  return /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/i.test(trimmed);
}

export function normalizeQuery(raw: string): NormalizedQuery {
  const partNumbers: string[] = [];
  const seen = new Set<string>();
  for (const match of raw.matchAll(PART_NUMBER)) {
    const value = match[0].toUpperCase();
    if (!seen.has(value)) {
      seen.add(value);
      partNumbers.push(value);
    }
  }

  let working = raw.toLowerCase();

  // Protect multi-character protocol spellings before punctuation is stripped.
  const placeholders = new Map<string, string>();
  PROTECTED_TOKENS.forEach((token, index) => {
    if (!working.includes(token)) return;
    const placeholder = ` zqx${index}zqx `;
    placeholders.set(placeholder, token);
    working = working.split(token).join(placeholder);
  });

  working = working
    .replace(/[‘’']s\b/g, '')
    .replace(/[^\p{L}\p{N} \-/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [placeholder, token] of placeholders) {
    working = working.split(placeholder.trim()).join(token);
  }

  const tokens = working
    .split(' ')
    .map((t) => t.replace(/^[-/]+|[-/]+$/g, ''))
    .filter((t) => t.length > 0);

  return { text: tokens.join(' '), tokens, partNumbers, raw };
}

/** Terms worth matching on: stop words dropped, everything else kept. */
export function contentTokens(query: NormalizedQuery): string[] {
  return query.tokens.filter((t) => !isStopWord(t));
}
