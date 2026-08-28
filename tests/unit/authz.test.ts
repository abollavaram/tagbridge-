import { describe, expect, it } from 'vitest';
import {
  canAdminister,
  canApproveQuotes,
  canReadOwnedResource,
  hasAtLeast,
} from '@/lib/auth/roles';

describe('role ordering', () => {
  it('ranks guest below buyer below sales below admin', () => {
    expect(hasAtLeast('admin', 'sales')).toBe(true);
    expect(hasAtLeast('sales', 'buyer')).toBe(true);
    expect(hasAtLeast('buyer', 'sales')).toBe(false);
    expect(hasAtLeast('guest', 'buyer')).toBe(false);
  });

  it('treats a missing role as guest', () => {
    expect(hasAtLeast(null, 'buyer')).toBe(false);
    expect(hasAtLeast(undefined, 'guest')).toBe(true);
  });
});

describe('quote approval', () => {
  it('is limited to sales and admin', () => {
    expect(canApproveQuotes('sales')).toBe(true);
    expect(canApproveQuotes('admin')).toBe(true);
    expect(canApproveQuotes('buyer')).toBe(false);
    expect(canApproveQuotes('guest')).toBe(false);
    expect(canApproveQuotes(null)).toBe(false);
  });
});

describe('administration', () => {
  it('is limited to admin', () => {
    expect(canAdminister('admin')).toBe(true);
    expect(canAdminister('sales')).toBe(false);
    expect(canAdminister('buyer')).toBe(false);
  });
});

describe('row-level ownership', () => {
  const owner = 'user-1';
  const other = 'user-2';

  it('lets a buyer read their own resource only', () => {
    expect(canReadOwnedResource('buyer', owner, owner)).toBe(true);
    expect(canReadOwnedResource('buyer', other, owner)).toBe(false);
  });

  it('lets staff read any resource', () => {
    expect(canReadOwnedResource('sales', other, owner)).toBe(true);
    expect(canReadOwnedResource('admin', other, owner)).toBe(true);
  });

  it('refuses an anonymous viewer', () => {
    expect(canReadOwnedResource('buyer', null, owner)).toBe(false);
    expect(canReadOwnedResource('admin', undefined, owner)).toBe(false);
  });
});
