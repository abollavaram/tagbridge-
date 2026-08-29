import Link from 'next/link';
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
      <nav aria-label="Administration areas">
        <ul className="space-y-2">
          <li>
            <Link href="/admin/sync" className="font-medium underline">
              Subscription sync
            </Link>
            <span className="text-ink-500">
              {' '}
              — event throughput, the dead-letter queue, and drift between the billing
              provider and the ERP.
            </span>
          </li>
        </ul>
      </nav>
      <p className="text-sm text-ink-500">
        Catalog administration and quote approval land alongside the rest of phase 3.
      </p>
    </div>
  );
}
