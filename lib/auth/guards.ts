import { redirect } from 'next/navigation';
import { auth } from './index';
import { canAdminister, canApproveQuotes, type Role } from './roles';

export interface Viewer {
  id: string;
  email: string;
  role: Role;
}

/**
 * Reads the session on the server. Every server action and route handler calls
 * this rather than trusting anything the client sent.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) return null;
  return { id: user.id, email: user.email, role: user.role ?? 'buyer' };
}

export async function requireViewer(returnTo = '/'): Promise<Viewer> {
  const viewer = await currentViewer();
  if (!viewer) redirect(`/signin?callbackUrl=${encodeURIComponent(returnTo)}`);
  return viewer;
}

export async function requireAdmin(returnTo = '/admin'): Promise<Viewer> {
  const viewer = await requireViewer(returnTo);
  if (!canAdminister(viewer.role)) redirect('/403');
  return viewer;
}

export async function requireQuoteApprover(returnTo = '/admin'): Promise<Viewer> {
  const viewer = await requireViewer(returnTo);
  if (!canApproveQuotes(viewer.role)) redirect('/403');
  return viewer;
}
