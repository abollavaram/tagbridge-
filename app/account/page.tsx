import { signOut } from '@/lib/auth';
import { requireViewer } from '@/lib/auth/guards';

export const metadata = { title: 'Account' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  // Re-checked here, not only in middleware.
  const viewer = await requireViewer('/account');

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-semibold tracking-tight">Account</h1>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
          <dt className="text-sm text-ink-500">Signed in as</dt>
          <dd className="mt-1 font-mono">{viewer.email}</dd>
        </div>
        <div className="rounded-lg border border-ink-100 p-4 dark:border-ink-700">
          <dt className="text-sm text-ink-500">Role</dt>
          <dd className="mt-1 font-mono">{viewer.role}</dd>
        </div>
      </dl>
      <p className="text-sm text-ink-500">
        Quotes and orders appear here from phase 3.
      </p>
      <form
        action={async () => {
          'use server';
          await signOut({ redirectTo: '/' });
        }}
      >
        <button type="submit" className="rounded border border-ink-300 px-4 py-2 text-sm">
          Sign out
        </button>
      </form>
    </div>
  );
}
