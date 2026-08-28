import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnv, resetEnvCache } from '@/lib/env';

const ORIGINAL = { ...process.env };

beforeEach(() => {
  resetEnvCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCache();
});

describe('environment contract', () => {
  it('accepts an environment with nothing but defaults', () => {
    process.env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    const env = getEnv();
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('rejects a malformed DATABASE_URL rather than failing later at connect time', () => {
    process.env = { NODE_ENV: 'test', DATABASE_URL: 'not-a-url' } as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/DATABASE_URL/);
  });

  it('rejects an unknown log level', () => {
    process.env = { NODE_ENV: 'test', LOG_LEVEL: 'chatty' } as NodeJS.ProcessEnv;
    expect(() => getEnv()).toThrow(/LOG_LEVEL/);
  });

  it('accepts a real Postgres URL', () => {
    process.env = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pw@db.example.com:5432/tagbridge?sslmode=require',
    } as NodeJS.ProcessEnv;
    expect(getEnv().DATABASE_URL).toContain('db.example.com');
  });
});
