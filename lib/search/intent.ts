import { contentTokens, type NormalizedQuery } from './normalize';
import type { SynonymGraph } from './synonym-graph';

/**
 * Query intent.
 *
 * Three shapes matter, because each deserves a different response:
 *
 *   specific-product        the buyer named a part number or a product
 *   compatibility-question  "will this work with what I already have"
 *   browse                  everything else
 *
 * Deterministic and inspectable, in the same spirit as the compatibility
 * resolver the spec asks for: rules in code, unit tested, no model needed to
 * decide what kind of question was asked.
 */

export type Intent = 'browse' | 'specific-product' | 'compatibility-question';

export interface IntentResult {
  intent: Intent;
  confidence: number;
  signals: string[];
}

/** Phrases that make a query a compatibility question rather than a search. */
const COMPATIBILITY_PHRASES = [
  'work with',
  'works with',
  'workwith',
  'compatible',
  'compatibility',
  'support',
  'supports',
  'talk to',
  'talks to',
  'communicate with',
  'connect to',
  'connects to',
  'interface with',
  'integrate with',
  'can i use',
  'does it do',
  'will it',
  'do i need',
];

const QUESTION_OPENERS = ['does', 'do', 'can', 'will', 'is', 'are', 'would', 'should'];

export function classifyIntent(
  query: NormalizedQuery,
  graph: SynonymGraph | null = null,
): IntentResult {
  const signals: string[] = [];
  const text = query.text;
  const tokens = contentTokens(query);

  if (tokens.length === 0) {
    return { intent: 'browse', confidence: 0.3, signals: ['empty query'] };
  }

  // A part number is the strongest signal there is: the buyer already knows
  // what they want and is checking that this is the place to get it.
  if (query.partNumbers.length > 0) {
    signals.push(`part number ${query.partNumbers[0]}`);
    // Unless they are asking whether it works with something.
    const compatHit = COMPATIBILITY_PHRASES.find((p) => text.includes(p));
    if (compatHit) {
      signals.push(`compatibility phrase "${compatHit}"`);
      return { intent: 'compatibility-question', confidence: 0.85, signals };
    }
    return { intent: 'specific-product', confidence: 0.95, signals };
  }

  const compatHits = COMPATIBILITY_PHRASES.filter((p) => text.includes(p));
  const opensAsQuestion = QUESTION_OPENERS.includes(query.tokens[0] ?? '');
  if (opensAsQuestion) signals.push('opens as a question');

  // Vendor and protocol mentions, counted through the synonym graph so that
  // "Rockwell" and "Allen-Bradley" count once each rather than not at all.
  const canonicals = graph ? graph.expand(tokens).canonicals : [];
  const technical = canonicals.filter(
    (c) => c !== 'license' && c !== 'database' && c !== 'alarm',
  );
  if (technical.length > 0) signals.push(`${technical.length} protocol or vendor concept(s)`);

  if (compatHits.length > 0) {
    for (const hit of compatHits) signals.push(`compatibility phrase "${hit}"`);
    // "Does X work with Y" needs two things to be about compatibility at all.
    const confidence = technical.length >= 2 ? 0.9 : opensAsQuestion ? 0.75 : 0.6;
    return { intent: 'compatibility-question', confidence, signals };
  }

  if (opensAsQuestion && technical.length >= 2) {
    return { intent: 'compatibility-question', confidence: 0.65, signals };
  }

  // A short, precise technical phrase reads as a product lookup rather than
  // browsing: "opc ua server for siemens" is not a symptom description.
  if (tokens.length <= 5 && technical.length >= 1) {
    signals.push('short technical phrase');
    return { intent: 'specific-product', confidence: 0.6, signals };
  }

  signals.push('descriptive query');
  return { intent: 'browse', confidence: 0.55, signals };
}
