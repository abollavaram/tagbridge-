import { describe, expect, it } from 'vitest';
import { SEED_SYNONYMS } from '@/lib/db/synonyms';

describe('seed synonym graph', () => {
  it('has no duplicate (term, canonical) edges', () => {
    const keys = SEED_SYNONYMS.map((s) => `${s.term}|${s.canonical}`);
    const seen = new Map<string, number>();
    for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes).toEqual([]);
  });

  it('stores every term and canonical in lower case', () => {
    for (const s of SEED_SYNONYMS) {
      expect(s.term, s.term).toBe(s.term.toLowerCase());
      expect(s.canonical, s.canonical).toBe(s.canonical.toLowerCase());
    }
  });

  it('never maps one term to two canonical forms', () => {
    const byTerm = new Map<string, Set<string>>();
    for (const s of SEED_SYNONYMS) {
      const set = byTerm.get(s.term) ?? new Set<string>();
      set.add(s.canonical);
      byTerm.set(s.term, set);
    }
    const ambiguous = [...byTerm.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([term, set]) => `${term} -> ${[...set].join(', ')}`);
    expect(ambiguous).toEqual([]);
  });

  it('covers the vendor and protocol groups the spec names', () => {
    const terms = new Set(SEED_SYNONYMS.map((s) => s.term));
    const required = [
      'allen-bradley',
      'rockwell',
      'controllogix',
      'compactlogix',
      'micrologix',
      'siemens',
      's7',
      'simatic',
      'schneider',
      'modicon',
      'opc ua',
      'opc da',
      'opc classic',
      'modbus rtu',
      'modbus tcp',
      'modbus ascii',
      'ethernet/ip',
      'cip',
      'mqtt',
      'sparkplug b',
      'bacnet',
      'bacnet/ip',
      'dnp3',
      'tag',
      'point',
      'register',
      'address',
      'historian',
      'data logger',
      'plc',
      'controller',
      'processor',
    ];
    const missing = required.filter((t) => !terms.has(t));
    expect(missing).toEqual([]);
  });

  it('puts terms the spec groups together under the same canonical form', () => {
    const canonical = new Map(SEED_SYNONYMS.map((s) => [s.term, s.canonical]));
    const groups = [
      ['allen-bradley', 'rockwell', 'controllogix', 'compactlogix', 'micrologix'],
      ['siemens', 's7', 'simatic'],
      ['schneider', 'modicon'],
      ['modbus rtu', 'modbus tcp', 'modbus ascii'],
      ['ethernet/ip', 'cip'],
      ['mqtt', 'sparkplug b'],
      ['tag', 'point', 'register', 'address'],
      ['historian', 'data logger'],
      ['plc', 'controller', 'processor'],
    ];
    for (const group of groups) {
      const forms = new Set(group.map((t) => canonical.get(t)));
      expect(forms.size, group.join(' / ')).toBe(1);
    }
  });
});
