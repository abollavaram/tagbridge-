import { describe, expect, it } from 'vitest';
import { SEED_SYNONYMS } from '@/lib/db/synonyms';
import { classifyIntent } from '@/lib/search/intent';
import { normalizeQuery } from '@/lib/search/normalize';
import { SynonymGraph } from '@/lib/search/synonym-graph';

const graph = new SynonymGraph(SEED_SYNONYMS);
const classify = (q: string) => classifyIntent(normalizeQuery(q), graph);

describe('specific-product', () => {
  it('recognises a bare part number', () => {
    const result = classify('TB-OPCUA-4100');
    expect(result.intent).toBe('specific-product');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('recognises a part number inside a sentence', () => {
    expect(classify('do you stock TB-GW-5200 in quantity').intent).toBe('specific-product');
  });

  it('reads a short technical phrase as a product lookup', () => {
    expect(classify('opc ua server for siemens').intent).toBe('specific-product');
    expect(classify('modbus rtu gateway').intent).toBe('specific-product');
  });
});

describe('compatibility-question', () => {
  it('recognises the canonical phrasing', () => {
    const result = classify('does this work with Modbus RTU over serial');
    expect(result.intent).toBe('compatibility-question');
    expect(result.signals.join(' ')).toContain('work with');
  });

  it('recognises other ways of asking the same thing', () => {
    for (const q of [
      'is the OPC UA server compatible with ControlLogix',
      'will it talk to a Siemens S7-1500',
      'can I connect to BACnet/IP from EtherNet/IP',
      'does it support Sparkplug B and MQTT',
    ]) {
      expect(classify(q).intent, q).toBe('compatibility-question');
    }
  });

  it('beats a part number when the question is about compatibility', () => {
    const result = classify('does TB-OPCUA-4100 work with CompactLogix');
    expect(result.intent).toBe('compatibility-question');
  });

  it('is more confident when two technical concepts are named', () => {
    const two = classify('does EtherNet/IP work with Modbus TCP');
    const one = classify('does it work with something');
    expect(two.confidence).toBeGreaterThan(one.confidence);
  });
});

describe('browse', () => {
  it('reads a descriptive symptom as browsing', () => {
    expect(classify('my line keeps dropping data overnight and nobody knows why').intent)
      .toBe('browse');
  });

  it('treats an empty query as browsing rather than throwing', () => {
    const result = classify('   ');
    expect(result.intent).toBe('browse');
    expect(result.signals).toContain('empty query');
  });
});

describe('signals', () => {
  it('always explains itself', () => {
    for (const q of ['TB-OPCUA-4100', 'does it work with modbus', 'something vague here']) {
      expect(classify(q).signals.length, q).toBeGreaterThan(0);
    }
  });

  it('reports a confidence between 0 and 1', () => {
    for (const q of ['TB-OPCUA-4100', 'does it work with modbus', 'x']) {
      const c = classify(q).confidence;
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});
