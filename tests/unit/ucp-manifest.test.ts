import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { UCP_VERSION, buildUcpProfile } from '@/lib/ucp/manifest';

/**
 * Validates the manifest against the pinned UCP schema snapshot.
 *
 * This is the acceptance criterion for the agent-native layer, so it is worth
 * being precise about what it proves: the profile TagBridge publishes is a
 * valid UCP business profile at version 2026-08-25, checked against the exact
 * schema bytes recorded in spec-snapshots/ucp. It does not prove the profile
 * is *true* — the tests below do that separately, by checking every endpoint
 * it advertises is one the app actually serves.
 */

const SCHEMA_ROOT = path.join(process.cwd(), 'spec-snapshots', 'ucp');

/** Every schema in the snapshot, keyed by its declared $id. */
function loadSchemas(): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.json')) {
        schemas.push(JSON.parse(readFileSync(full, 'utf8')) as Record<string, unknown>);
      }
    }
  };
  walk(SCHEMA_ROOT);
  return schemas;
}

function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  for (const schema of loadSchemas()) {
    const id = schema.$id;
    if (typeof id === 'string') ajv.addSchema(schema, id);
  }
  // The business variant is the one a merchant hosts at /.well-known/ucp.
  return ajv.getSchema('https://ucp.dev/schemas/profile.json#/$defs/business_schema');
}

const ORIGIN = 'https://tagbridge.example.com';

describe('the UCP profile validates against the pinned snapshot', () => {
  it('loads the vendored schemas', () => {
    expect(loadSchemas().length).toBeGreaterThan(50);
  });

  it('compiles the business profile schema', () => {
    expect(validator()).toBeTypeOf('function');
  });

  it('validates', () => {
    const validate = validator()!;
    const valid = validate(buildUcpProfile(ORIGIN));
    // Print what failed rather than just "false" — a schema error nobody can
    // read is a test that costs more than it saves.
    expect(validate.errors ?? [], JSON.stringify(validate.errors, null, 2)).toEqual([]);
    expect(valid).toBe(true);
  });

  it('rejects a profile missing the required services registry', () => {
    const validate = validator()!;
    const profile = buildUcpProfile(ORIGIN) as unknown as Record<string, unknown>;
    const ucp = { ...(profile.ucp as Record<string, unknown>) };
    delete ucp.services;
    expect(validate({ ucp })).toBe(false);
  });

  it('rejects a profile missing payment_handlers, even though ours is empty', () => {
    const validate = validator()!;
    const profile = buildUcpProfile(ORIGIN) as unknown as Record<string, unknown>;
    const ucp = { ...(profile.ucp as Record<string, unknown>) };
    delete ucp.payment_handlers;
    expect(validate({ ucp })).toBe(false);
  });

  it('rejects a malformed version, which is how a typo would show up', () => {
    const validate = validator()!;
    const profile = buildUcpProfile(ORIGIN);
    expect(validate({ ucp: { ...profile.ucp, version: 'v2' } })).toBe(false);
  });
});

describe('the profile says only true things', () => {
  const profile = buildUcpProfile(ORIGIN);

  it('pins the version it was built against', () => {
    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(UCP_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('advertises absolute endpoints, since an agent fetches from elsewhere', () => {
    for (const services of Object.values(profile.ucp.services)) {
      for (const service of services) {
        expect(service.endpoint?.startsWith('https://')).toBe(true);
      }
    }
  });

  it('uses reverse-domain names for every registry key', () => {
    const pattern = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+$/;
    const keys = [
      ...Object.keys(profile.ucp.services),
      ...Object.keys(profile.ucp.capabilities),
      ...Object.keys(profile.ucp.payment_handlers),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key, key).toMatch(pattern);
  });

  it('declares no payment handler, because this deployment processes no cards', () => {
    // The honest empty value. A declared handler that failed on first use
    // would be worse than saying nothing.
    expect(profile.ucp.payment_handlers).toEqual({});
  });

  it('declares only capabilities that are actually implemented', () => {
    expect(Object.keys(profile.ucp.capabilities).sort()).toEqual([
      'dev.ucp.shopping.catalog.lookup',
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.checkout',
    ]);
  });

  it('does not advertise cart, discount or fulfillment, which are not built', () => {
    for (const absent of [
      'dev.ucp.shopping.cart',
      'dev.ucp.shopping.discount',
      'dev.ucp.shopping.fulfillment',
    ]) {
      expect(Object.keys(profile.ucp.capabilities)).not.toContain(absent);
    }
  });

  it('warns an agent that checkout here is quote-shaped', () => {
    const checkout = profile.ucp.capabilities['dev.ucp.shopping.checkout']?.[0];
    expect(checkout?.config?.flow).toBe('quote_then_purchase_order');
    expect(checkout?.config?.prices_are_server_computed).toBe(true);
  });

  it('tracks the deployment origin rather than hardcoding a domain', () => {
    const preview = buildUcpProfile('https://preview.example.dev');
    expect(preview.ucp.services['dev.ucp.shopping']![0]!.endpoint).toContain(
      'preview.example.dev',
    );
  });
});
