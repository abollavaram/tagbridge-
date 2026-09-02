import { describe, expect, it } from 'vitest';
import { extractTagCount, isResolvable, translateCompatibility } from '@/lib/agent/translate';

describe('tag counts', () => {
  it('reads a plain number next to "tags"', () => {
    expect(extractTagCount('about 5000 tags')).toBe(5000);
  });

  it('reads a thousands separator', () => {
    expect(extractTagCount('12,000 points')).toBe(12000);
  });

  it('reads the k shorthand', () => {
    expect(extractTagCount('5k tags')).toBe(5000);
  });

  it('reads "thousand" spelled out', () => {
    expect(extractTagCount('3 thousand signals')).toBe(3000);
  });

  it('accepts registers and items as tag words', () => {
    expect(extractTagCount('900 registers')).toBe(900);
    expect(extractTagCount('40 items')).toBe(40);
  });

  it('ignores a number that is not a tag count', () => {
    // The classic false positive: a port number becoming a licence size.
    expect(extractTagCount('Modbus TCP on port 502')).toBeNull();
  });

  it('ignores a bare number with no tag word at all', () => {
    expect(extractTagCount('we have 12 of them')).toBeNull();
  });

  it('refuses a count beyond what a licence can express', () => {
    expect(extractTagCount('9,000,000 tags')).toBeNull();
  });

  it('handles the plus form buyers actually write', () => {
    expect(extractTagCount('5000+ tags')).toBe(5000);
  });
});

describe('source families', () => {
  const cases: [string, string][] = [
    ['we run ControlLogix', 'allen-bradley'],
    ['a CompactLogix rack', 'allen-bradley'],
    ['Rockwell kit', 'allen-bradley'],
    ['Allen-Bradley PLCs', 'allen-bradley'],
    ['Siemens S7-1500', 'siemens'],
    ['a SIMATIC line', 'siemens'],
    ['Modicon Quantum', 'modicon'],
    ['Schneider gear', 'modicon'],
    ['Mitsubishi MELSEC', 'mitsubishi'],
    ['BACnet building automation', 'bacnet'],
    ['DNP3 outstations', 'dnp3-rtu'],
    ['IEC 61850 substation', 'iec61850-ied'],
    ['a serial ASCII weigh scale', 'serial-ascii'],
    ['classic OPC DA', 'opc-da-server'],
  ];

  for (const [text, expected] of cases) {
    it(`reads "${text}" as ${expected}`, () => {
      expect(translateCompatibility(text).sourceDevice).toBe(expected);
    });
  }
});

describe('destinations', () => {
  const cases: [string, string][] = [
    ['into SQL Server', 'sql-server'],
    ['into Azure SQL', 'sql-server'],
    ['a Postgres database', 'postgresql'],
    ['TimescaleDB', 'postgresql'],
    ['our InfluxDB', 'influxdb'],
    ['the historian', 'influxdb'],
    ['Snowflake', 'snowflake'],
    ['an MQTT broker', 'mqtt-broker'],
    ['Sparkplug B host', 'sparkplug-host'],
    ['Ignition SCADA', 'scada-hmi'],
    ['a CSV file', 'file'],
  ];

  for (const [text, expected] of cases) {
    it(`reads "${text}" as ${expected}`, () => {
      expect(translateCompatibility(text).destinationSystem).toBe(expected);
    });
  }
});

describe('translation as a whole', () => {
  it('reads a complete request', () => {
    const t = translateCompatibility(
      'We have ControlLogix PLCs on EtherNet/IP and need about 5,000 tags going into SQL Server.',
    );
    expect(t.sourceDevice).toBe('allen-bradley');
    expect(t.destinationSystem).toBe('sql-server');
    expect(t.transport).toBe('ethernet-ip');
    expect(t.tagCount).toBe(5000);
    expect(t.missing).toEqual([]);
    expect(isResolvable(t)).toBe(true);
  });

  it('names what is missing rather than guessing it', () => {
    const t = translateCompatibility('We have ControlLogix PLCs.');
    expect(t.missing).toContain('destinationSystem');
    expect(t.missing).toContain('tagCount');
    expect(isResolvable(t)).toBe(false);
  });

  it('reads redundancy', () => {
    expect(
      translateCompatibility('siemens to influxdb, 100 tags, needs redundancy').redundancyRequired,
    ).toBe(true);
  });

  it('reads a flaky link', () => {
    expect(
      translateCompatibility('modicon to mqtt, 50 tags, the link is intermittent').intermittentLink,
    ).toBe(true);
  });

  it('reads legacy firmware', () => {
    expect(
      translateCompatibility('allen-bradley PLC-5 to sql server, 200 tags').legacyFirmware,
    ).toBe(true);
  });

  it('defaults the optional flags to false rather than undefined', () => {
    const t = translateCompatibility('siemens to postgres, 10 tags');
    expect(t.redundancyRequired).toBe(false);
    expect(t.intermittentLink).toBe(false);
    expect(t.legacyFirmware).toBe(false);
  });

  it('prefers the longer phrase when two overlap', () => {
    // "opc ua server" must not be swallowed by "opc ua".
    expect(translateCompatibility('an OPC UA server, 10 tags, to postgres').sourceDevice).toBe(
      'opc-ua-server',
    );
  });

  it('explains what it matched, so a wrong answer is debuggable', () => {
    const t = translateCompatibility('ControlLogix to SQL Server, 5000 tags');
    expect(t.signals.join(' ')).toContain('allen-bradley');
    expect(t.signals.join(' ')).toContain('sql-server');
  });

  it('returns everything missing for an empty request', () => {
    expect(translateCompatibility('').missing).toHaveLength(3);
  });

  it('is case insensitive', () => {
    const upper = translateCompatibility('CONTROLLOGIX TO SQL SERVER, 5000 TAGS');
    expect(upper.sourceDevice).toBe('allen-bradley');
    expect(upper.tagCount).toBe(5000);
  });
});

describe('a transport without a vendor', () => {
  it('infers the generic source family rather than giving up', () => {
    const t = translateCompatibility('something that speaks Modbus TCP into Postgres, 150 registers');
    expect(t.sourceDevice).toBe('other');
    expect(t.transport).toBe('modbus-tcp');
    expect(isResolvable(t)).toBe(true);
  });

  it('says the source was inferred, not matched', () => {
    const t = translateCompatibility('speaks Modbus TCP to postgres, 10 tags');
    expect(t.signals.join(' ')).toContain('no vendor named');
  });

  it('still prefers a named vendor over the inference', () => {
    const t = translateCompatibility('Siemens over Modbus TCP to postgres, 10 tags');
    expect(t.sourceDevice).toBe('siemens');
  });

  it('does not invent a source when no transport is named either', () => {
    expect(translateCompatibility('into postgres, 10 tags').sourceDevice).toBeUndefined();
  });
});
