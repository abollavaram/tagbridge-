import type { SeedSynonym } from '@/lib/db/synonyms';

/**
 * Bidirectional synonym expansion.
 *
 * The table stores directed `term -> canonical` edges, but a search needs the
 * closure: a query hitting either side of an edge picks up the other, and every
 * term sharing a canonical form expands to all the rest. "Rockwell" therefore
 * has to reach the Allen-Bradley products even though neither word appears in
 * the other's row.
 *
 * Expansion runs over multi-word phrases before single tokens, so "opc ua"
 * expands as one concept rather than as "opc" plus "ua".
 */

export interface ExpansionResult {
  /** Every term to search for, the originals first. */
  terms: string[];
  /** Canonical forms the query touched, for the intent classifier. */
  canonicals: string[];
  /** Which original term produced which additions. */
  expandedFrom: Map<string, string[]>;
}

/**
 * Candidate spellings to look up, most specific first.
 *
 * Engineers type plurals — "tags", "gateways", "registers" — and the table
 * stores the singular. Exact matches always win; the folded form is only tried
 * when the exact one misses, so "modbus" is never mistaken for a plural.
 */
export function lookupVariants(term: string): string[] {
  const lower = term.toLowerCase();
  const variants = [lower];
  if (lower.endsWith('ies') && lower.length > 4) variants.push(`${lower.slice(0, -3)}y`);
  else if (lower.endsWith('es') && lower.length > 3) variants.push(lower.slice(0, -2));
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 3) {
    variants.push(lower.slice(0, -1));
  }
  return variants;
}

export class SynonymGraph {
  private readonly canonicalByTerm = new Map<string, string>();
  private readonly termsByCanonical = new Map<string, string[]>();
  private readonly maxPhraseWords: number;

  constructor(edges: readonly SeedSynonym[]) {
    let longest = 1;
    for (const edge of edges) {
      const term = edge.term.toLowerCase();
      const canonical = edge.canonical.toLowerCase();
      this.canonicalByTerm.set(term, canonical);
      const bucket = this.termsByCanonical.get(canonical) ?? [];
      if (!bucket.includes(term)) bucket.push(term);
      this.termsByCanonical.set(canonical, bucket);
      longest = Math.max(longest, term.split(' ').length);
    }
    this.maxPhraseWords = longest;
  }

  static fromRows(rows: readonly { term: string; canonical: string; kind: string }[]): SynonymGraph {
    return new SynonymGraph(rows as readonly SeedSynonym[]);
  }

  get size(): number {
    return this.canonicalByTerm.size;
  }

  canonicalFor(term: string): string | undefined {
    for (const variant of lookupVariants(term)) {
      const canonical = this.canonicalByTerm.get(variant);
      if (canonical) return canonical;
    }
    return undefined;
  }

  /** The spelling actually present in the table for this term, if any. */
  private knownSpelling(term: string): string | undefined {
    return lookupVariants(term).find((v) => this.canonicalByTerm.has(v));
  }

  /** Every term sharing a canonical form with this one, excluding itself. */
  siblingsOf(term: string): string[] {
    const canonical = this.canonicalFor(term);
    if (!canonical) return [];
    const known = this.knownSpelling(term) ?? term.toLowerCase();
    return (this.termsByCanonical.get(canonical) ?? []).filter((t) => t !== known);
  }

  /**
   * Greedily matches the longest known phrase at each position, so a
   * multi-word term is never shadowed by one of its own words.
   */
  private matchPhrases(tokens: readonly string[]): string[] {
    const matches: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      let matched = false;
      const maxLength = Math.min(this.maxPhraseWords, tokens.length - index);
      for (let length = maxLength; length >= 1; length -= 1) {
        const phrase = tokens.slice(index, index + length).join(' ');
        if (this.knownSpelling(phrase)) {
          matches.push(phrase);
          index += length;
          matched = true;
          break;
        }
      }
      if (!matched) index += 1;
    }
    return matches;
  }

  expand(tokens: readonly string[]): ExpansionResult {
    const terms: string[] = [];
    const seen = new Set<string>();
    const add = (term: string): void => {
      if (seen.has(term)) return;
      seen.add(term);
      terms.push(term);
    };

    for (const token of tokens) add(token);

    const canonicals: string[] = [];
    const expandedFrom = new Map<string, string[]>();

    for (const phrase of this.matchPhrases(tokens)) {
      const canonical = this.canonicalFor(phrase);
      if (canonical && !canonicals.includes(canonical)) canonicals.push(canonical);

      const additions: string[] = [];
      for (const sibling of this.siblingsOf(phrase)) {
        if (!seen.has(sibling)) additions.push(sibling);
        add(sibling);
      }
      if (canonical && !seen.has(canonical)) {
        additions.push(canonical);
        add(canonical);
      }
      if (additions.length > 0) expandedFrom.set(phrase, additions);
    }

    return { terms, canonicals, expandedFrom };
  }
}
