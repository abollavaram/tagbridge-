import { requireAdmin } from '@/lib/auth/guards';

export const metadata = { title: 'Administration' };
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  // Middleware is the first gate; this is the one that decides.
  const viewer = await requireAdmin();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Administration</h1>
      <p className="text-ink-700 dark:text-ink-300">
        Signed in as <span className="font-mono">{viewer.email}</span>.
      </p>
      <p className="text-sm text-ink-500">
        Catalog administration lands in phase 1, quote approval in phase 3 and the sync
        dashboard in phase 4.
      </p>
    </div>
  );
}
