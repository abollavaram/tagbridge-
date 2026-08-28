import { describe, expect, it } from 'vitest';
import { SEED_SYNONYMS } from '@/lib/db/synonyms';
import { SynonymGraph } from '@/lib/search/synonym-graph';
import { normalizeQuery } from '@/lib/search/normalize';

const graph = new SynonymGraph(SEED_SYNONYMS);

function expandQuery(text: string): string[] {
  return graph.expand(normalizeQuery(text).tokens).terms;
}

describe('synonym expansion', () => {
  it('loads every seeded edge', () => {
    expect(graph.size).toBeGreaterThan(100);
  });

  it('reaches Allen-Bradley from Rockwell, which is the whole point', () => {
    const terms = expandQuery('Rockwell PLC connector');
    expect(terms).toContain('allen-bradley');
    expect(terms).toContain('controllogix');
  });

  it('expands in the other direction too', () => {
    expect(expandQuery('ControlLogix tags')).toContain('rockwell');
  });

  it('keeps the original terms first', () => {
    const terms = expandQuery('Rockwell driver');
    expect(terms[0]).toBe('rockwell');
    expect(terms).toContain('driver');
  });

  it('expands a multi-word protocol as one concept', () => {
    const terms = expandQuery('need an OPC UA server');
    expect(terms).toContain('opcua');
    expect(terms).toContain('opc-ua');
    // "ua" alone is not a seeded canonical form on its own account.
    expect(graph.canonicalFor('opc ua')).toBe('opc-ua');
  });

  it('does not let a single word shadow a longer phrase', () => {
    const result = graph.expand(['opc', 'ua']);
    expect(result.canonicals).toContain('opc-ua');
    expect(result.canonicals).not.toContain('opc-classic');
  });

  it('links the Modbus variants to each other', () => {
    const terms = expandQuery('Modbus RTU over serial');
    expect(terms).toContain('modbus tcp');
    expect(terms).toContain('modbus ascii');
  });

  it('links EtherNet/IP to CIP', () => {
    expect(expandQuery('does it speak EtherNet/IP')).toContain('cip');
  });

  it('links the concept vocabulary engineers actually use', () => {
    const terms = expandQuery('how many tags can it do');
    expect(terms).toContain('point');
    expect(terms).toContain('register');
  });

  it('reports which term produced which additions', () => {
    const result = graph.expand(normalizeQuery('Siemens S7').tokens);
    expect([...result.expandedFrom.keys()]).toContain('siemens');
  });

  it('leaves an unknown term untouched', () => {
    const terms = expandQuery('flibbertigibbet');
    expect(terms).toEqual(['flibbertigibbet']);
  });

  it('never duplicates a term', () => {
    const terms = expandQuery('Allen-Bradley Rockwell ControlLogix');
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('handles an empty query', () => {
    const result = graph.expand([]);
    expect(result.terms).toEqual([]);
    expect(result.canonicals).toEqual([]);
  });
});

describe('graph structure', () => {
  it('gives siblings but not the term itself', () => {
    const siblings = graph.siblingsOf('rockwell');
    expect(siblings).toContain('allen-bradley');
    expect(siblings).not.toContain('rockwell');
  });

  it('returns nothing for a term it does not know', () => {
    expect(graph.siblingsOf('nonsense')).toEqual([]);
  });
});
