export const ROLES = ['guest', 'buyer', 'sales', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Ordered least to most privileged. Comparisons use this ordering only. */
const RANK: Record<Role, number> = { guest: 0, buyer: 1, sales: 2, admin: 3 };

export function hasAtLeast(role: Role | undefined | null, required: Role): boolean {
  if (!role) return RANK.guest >= RANK[required];
  return RANK[role] >= RANK[required];
}

export function canApproveQuotes(role: Role | undefined | null): boolean {
  return role === 'sales' || role === 'admin';
}

export function canAdminister(role: Role | undefined | null): boolean {
  return role === 'admin';
}

/** A buyer may only ever read a resource they own. Staff may read any. */
export function canReadOwnedResource(
  role: Role | undefined | null,
  viewerId: string | undefined | null,
  ownerId: string,
): boolean {
  if (!viewerId) return false;
  if (role === 'sales' || role === 'admin') return true;
  return viewerId === ownerId;
}
