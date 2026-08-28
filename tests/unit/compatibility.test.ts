import { describe, expect, it } from 'vitest';
import { SEED_PRODUCTS } from '@/lib/db/catalog';
import {
  CompatibilityError,
  licenseTierFor,
  resolveCompatibility,
  TIER_BOUNDARIES,
} from '@/lib/compatibility/resolver';
import type { CompatibilityRequest } from '@/lib/compatibility/types';

const catalogSkus = new Set(SEED_PRODUCTS.map((p) => p.sku));

function request(overrides: Partial<CompatibilityRequest> = {}): unknown {
  return {
    sourceDevice: 'allen-bradley',
    destinationSystem: 'sql-server',
    tagCount: 800,
    redundancyRequired: false,
    intermittentLink: false,
    legacyFirmware: false,
    ...overrides,
  };
}

describe('the resolver only ever names real products', () => {
  it('returns SKUs that exist in the catalogue, across every combination', () => {
    const sources = ['allen-bradley', 'siemens', 'modicon', 'mitsubishi', 'bacnet',
      'dnp3-rtu', 'iec61850-ied', 'serial-ascii', 'opc-da-server', 'opc-ua-server'] as const;
    const destinations = ['sql-server', 'postgresql', 'influxdb', 'snowflake',
      'mqtt-broker', 'sparkplug-host', 'opc-ua-client', 'scada-hmi', 'file'] as const;

    for (const sourceDevice of sources) {
      for (const destinationSystem of destinations) {
        for (const redundancyRequired of [false, true]) {
          for (const intermittentLink of [false, true]) {
            const result = resolveCompatibility(
              request({ sourceDevice, destinationSystem, redundancyRequired, intermittentLink }),
            );
            for (const item of result.bundle) {
              expect(catalogSkus.has(item.sku), `${sourceDevice}/${destinationSystem}: ${item.sku}`)
                .toBe(true);
            }
          }
        }
      }
    }
  });

  it('never repeats a product in one bundle', () => {
    const result = resolveCompatibility(
      request({ redundancyRequired: true, intermittentLink: true, tagCount: 20_000 }),
    );
    const skus = result.bundle.map((b) => b.sku);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('gives every bundle item a reason written for the buyer', () => {
    const result = resolveCompatibility(request({ redundancyRequired: true }));
    for (const item of result.bundle) {
      expect(item.reason.length, item.sku).toBeGreaterThan(20);
    }
  });
});

describe('source connectivity', () => {
  it('picks the Allen-Bradley server for a ControlLogix source', () => {
    const result = resolveCompatibility(request({ sourceDevice: 'allen-bradley' }));
    expect(result.bundle.map((b) => b.sku)).toContain('TB-OPCUA-4100');
  });

  it('picks the S7 server for Siemens', () => {
    expect(
      resolveCompatibility(request({ sourceDevice: 'siemens' })).bundle.map((b) => b.sku),
    ).toContain('TB-OPCUA-4200');
  });

  it('refuses to guess for an unknown device family', () => {
    const result = resolveCompatibility(request({ sourceDevice: 'other' }));
    expect(result.supported).toBe(false);
    expect(result.gaps.map((g) => g.code)).toContain('unknown-source-device');
  });
});

describe('destination', () => {
  it('adds the matching historian connector', () => {
    const cases = [
      ['sql-server', 'TB-HIST-6100'],
      ['postgresql', 'TB-HIST-6200'],
      ['influxdb', 'TB-HIST-6300'],
      ['snowflake', 'TB-HIST-6400'],
    ] as const;
    for (const [destinationSystem, sku] of cases) {
      const result = resolveCompatibility(request({ destinationSystem }));
      expect(result.bundle.map((b) => b.sku), destinationSystem).toContain(sku);
    }
  });

  it('adds nothing extra when the destination is an OPC UA client', () => {
    const result = resolveCompatibility(request({ destinationSystem: 'opc-ua-client' }));
    expect(result.bundle.filter((b) => b.role === 'destination-connector')).toEqual([]);
    expect(result.rulesApplied).toContain('destination:native-opc-ua');
  });

  it('adds the primary host alongside the edge node for Sparkplug', () => {
    const skus = resolveCompatibility(
      request({ destinationSystem: 'sparkplug-host' }),
    ).bundle.map((b) => b.sku);
    expect(skus).toContain('TB-MQTT-7100');
    expect(skus).toContain('TB-MQTT-7300');
  });
});

describe('licence tier', () => {
  it('maps tag count to the ladder the catalogue actually sells', () => {
    expect(licenseTierFor(1)).toBe('small');
    expect(licenseTierFor(TIER_BOUNDARIES.small)).toBe('small');
    expect(licenseTierFor(TIER_BOUNDARIES.small + 1)).toBe('medium');
    expect(licenseTierFor(TIER_BOUNDARIES.medium)).toBe('medium');
    expect(licenseTierFor(TIER_BOUNDARIES.medium + 1)).toBe('large');
  });

  it('reports the tier and the count it was derived from', () => {
    const result = resolveCompatibility(request({ tagCount: 4_000 }));
    expect(result.licenseTier).toBe('medium');
    expect(result.tagCount).toBe(4_000);
  });

  it('warns that scan rate, not licensing, is the real constraint at scale', () => {
    const result = resolveCompatibility(request({ tagCount: 40_000 }));
    expect(result.gaps.map((g) => g.code)).toContain('high-tag-count');
    expect(result.bundle.map((b) => b.sku)).toContain('TB-DIAG-9900');
  });

  it('does not raise that warning for a small system', () => {
    const result = resolveCompatibility(request({ tagCount: 200 }));
    expect(result.gaps.map((g) => g.code)).not.toContain('high-tag-count');
  });
});

describe('redundancy', () => {
  it('adds the OPC UA redundancy module by default', () => {
    const skus = resolveCompatibility(request({ redundancyRequired: true })).bundle.map((b) => b.sku);
    expect(skus).toContain('TB-RED-9100');
  });

  it('uses the Modbus-specific module for a Modbus source', () => {
    const skus = resolveCompatibility(
      request({ sourceDevice: 'modicon', redundancyRequired: true }),
    ).bundle.map((b) => b.sku);
    expect(skus).toContain('TB-RED-9200');
    expect(skus).not.toContain('TB-RED-9100');
  });

  it('always pairs redundancy with configuration sync', () => {
    const skus = resolveCompatibility(request({ redundancyRequired: true })).bundle.map((b) => b.sku);
    expect(skus).toContain('TB-RED-9500');
  });

  it('adds nothing redundancy-shaped when it was not asked for', () => {
    const roles = resolveCompatibility(request()).bundle.map((b) => b.role);
    expect(roles).not.toContain('redundancy');
  });
});

describe('intermittent links', () => {
  it('adds store-and-forward for a database destination', () => {
    const skus = resolveCompatibility(request({ intermittentLink: true })).bundle.map((b) => b.sku);
    expect(skus).toContain('TB-RED-9300');
  });

  it('adds the edge buffer for an MQTT destination instead', () => {
    const skus = resolveCompatibility(
      request({ intermittentLink: true, destinationSystem: 'mqtt-broker' }),
    ).bundle.map((b) => b.sku);
    expect(skus).toContain('TB-MQTT-7500');
    expect(skus).not.toContain('TB-RED-9300');
  });

  it('says plainly that it cannot size the buffer without more information', () => {
    const gaps = resolveCompatibility(request({ intermittentLink: true })).gaps;
    expect(gaps.map((g) => g.code)).toContain('buffer-sizing-unknown');
  });
});

describe('the gaps are the point', () => {
  it('explains the legacy firmware case rather than silently working around it', () => {
    const result = resolveCompatibility(request({ legacyFirmware: true }));
    const gap = result.gaps.find((g) => g.code === 'firmware-predates-opc-ua');
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe('advisory');
    expect(result.supported).toBe(true);
  });

  it('bridges a transport the source driver does not speak', () => {
    const result = resolveCompatibility(
      request({ sourceDevice: 'allen-bradley', transport: 'modbus-tcp' }),
    );
    expect(result.bundle.map((b) => b.sku)).toContain('TB-GW-5400');
    expect(result.gaps.map((g) => g.code)).toContain('transport-needs-bridge');
    expect(result.supported).toBe(true);
  });

  it('does not add a bridge when the transport is already native', () => {
    const result = resolveCompatibility(
      request({ sourceDevice: 'allen-bradley', transport: 'ethernet-ip' }),
    );
    expect(result.bundle.filter((b) => b.role === 'protocol-bridge')).toEqual([]);
  });

  it('gives every gap a remedy, because a gap without one is a shrug', () => {
    const result = resolveCompatibility(
      request({ sourceDevice: 'other', intermittentLink: true, tagCount: 60_000 }),
    );
    expect(result.gaps.length).toBeGreaterThan(1);
    for (const gap of result.gaps) {
      expect(gap.remedy.length, gap.code).toBeGreaterThan(20);
    }
  });

  it('marks the result unsupported only when something blocking stands in the way', () => {
    expect(resolveCompatibility(request()).supported).toBe(true);
    expect(resolveCompatibility(request({ sourceDevice: 'other' })).supported).toBe(false);
  });
});

describe('the request schema is the trust boundary', () => {
  it('rejects an unknown device family rather than coercing it', () => {
    expect(() => resolveCompatibility(request({ sourceDevice: 'plc-9000' as never })))
      .toThrow(CompatibilityError);
  });

  it('rejects a non-positive or fractional tag count', () => {
    for (const tagCount of [0, -5, 2.5]) {
      expect(() => resolveCompatibility(request({ tagCount })), `${tagCount}`)
        .toThrow(CompatibilityError);
    }
  });

  it('rejects an absurd tag count rather than quoting for it', () => {
    expect(() => resolveCompatibility(request({ tagCount: 50_000_000 })))
      .toThrow(CompatibilityError);
  });

  it('rejects any extra field, which is how a price would try to arrive', () => {
    expect(() =>
      resolveCompatibility({ ...(request() as object), unitPriceCents: 1 }),
    ).toThrow(CompatibilityError);
    expect(() =>
      resolveCompatibility({ ...(request() as object), discountPercent: 90 }),
    ).toThrow(CompatibilityError);
  });

  it('names the offending field so the caller can fix it', () => {
    try {
      resolveCompatibility(request({ tagCount: -1 }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).toContain('tagCount');
    }
  });
});

describe('determinism', () => {
  it('gives the same answer every time', () => {
    const input = request({ redundancyRequired: true, tagCount: 9_000 });
    expect(resolveCompatibility(input)).toEqual(resolveCompatibility(input));
  });

  it('records the rules that fired, so a surprising bundle is traceable', () => {
    const result = resolveCompatibility(
      request({ sourceDevice: 'siemens', redundancyRequired: true, tagCount: 30_000 }),
    );
    expect(result.rulesApplied).toContain('source:siemens');
    expect(result.rulesApplied).toContain('capacity:large');
    expect(result.rulesApplied.some((r) => r.startsWith('redundancy:'))).toBe(true);
  });
});
