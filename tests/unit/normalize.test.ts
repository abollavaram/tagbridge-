import { describe, expect, it } from 'vitest';
import {
  contentTokens,
  looksLikePartNumber,
  normalizeQuery,
} from '@/lib/search/normalize';

describe('normalizeQuery', () => {
  it('lower-cases and strips punctuation from prose', () => {
    const q = normalizeQuery('Modbus device will not talk to my SCADA!');
    expect(q.text).toBe('modbus device will not talk to my scada');
  });

  it('keeps a part number intact and records it', () => {
    const q = normalizeQuery('do you stock TB-OPCUA-4100?');
    expect(q.partNumbers).toEqual(['TB-OPCUA-4100']);
    expect(q.tokens).toContain('tb-opcua-4100');
  });

  it('records several part numbers in the order they appeared', () => {
    const q = normalizeQuery('compare TB-GW-5100 with TB-GW-5200');
    expect(q.partNumbers).toEqual(['TB-GW-5100', 'TB-GW-5200']);
  });

  it('does not split protocol names on their punctuation', () => {
    const cases: [string, string][] = [
      ['does it do EtherNet/IP', 'ethernet/ip'],
      ['BACnet/IP controllers', 'bacnet/ip'],
      ['RS-485 multidrop', 'rs-485'],
      ['Sparkplug B edge node', 'sparkplug b'],
      ['Allen-Bradley PLC', 'allen-bradley'],
      ['IEC 61850 substation', 'iec 61850'],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeQuery(input).text, input).toContain(expected);
    }
  });

  it('preserves the raw query', () => {
    const raw = '  Rockwell PLC connector  ';
    expect(normalizeQuery(raw).raw).toBe(raw);
  });

  it('collapses repeated whitespace', () => {
    expect(normalizeQuery('opc   ua    server').text).toBe('opc ua server');
  });

  it('handles an empty query without throwing', () => {
    const q = normalizeQuery('   ');
    expect(q.tokens).toEqual([]);
    expect(q.text).toBe('');
    expect(q.partNumbers).toEqual([]);
  });

  it('drops possessives rather than leaving a stray s', () => {
    expect(normalizeQuery('the PLC’s tags').tokens).not.toContain('s');
  });
});

describe('looksLikePartNumber', () => {
  it('accepts catalogue-shaped part numbers', () => {
    for (const token of ['TB-OPCUA-4100', 'TB-GW-5100-S', 'S7-1500', 'DNP3']) {
      expect(looksLikePartNumber(token), token).toBe(true);
    }
  });

  it('rejects ordinary words and bare numbers', () => {
    for (const token of ['modbus', 'gateway', '5000', 'ab']) {
      expect(looksLikePartNumber(token), token).toBe(false);
    }
  });
});

describe('contentTokens', () => {
  it('drops stop words and keeps the meaning', () => {
    const q = normalizeQuery('how do I get tag data from a ControlLogix into SQL Server');
    expect(contentTokens(q)).toEqual(['tag', 'data', 'controllogix', 'sql', 'server']);
  });

  it('never drops a part number as a stop word', () => {
    const q = normalizeQuery('is the TB-OPCUA-4100 in stock');
    expect(contentTokens(q)).toContain('tb-opcua-4100');
  });
});
