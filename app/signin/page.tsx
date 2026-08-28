import { signIn } from '@/lib/auth';
import { providerAvailability } from '@/lib/auth/providers';

export const metadata = { title: 'Sign in' };

const DEMO_ACCOUNTS = [
  { email: 'buyer@example.com', label: 'Buyer — sees only their own quotes' },
  { email: 'sales@example.com', label: 'Sales — can approve quotes' },
  { email: 'admin@example.com', label: 'Admin — full administration' },
];

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const params = await searchParams;
  const callbackUrl = params.callbackUrl ?? '/account';
  const { google: googleEnabled, email: emailEnabled, demo: demoEnabled } =
    providerAvailability();

  return (
    <div className="mx-auto max-w-md space-y-8">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>

      {params.error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          That sign-in attempt did not complete. Try again.
        </p>
      ) : null}

      {emailEnabled ? (
        <form
          action={async (formData: FormData) => {
            'use server';
            await signIn('nodemailer', {
              email: String(formData.get('email') ?? ''),
              redirectTo: callbackUrl,
            });
          }}
          className="space-y-3"
        >
          <label htmlFor="email" className="block text-sm font-medium">
            Email a sign-in link
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="w-full rounded border border-ink-300 px-3 py-2"
          />
          <button
            type="submit"
            className="w-full rounded bg-signal-600 px-4 py-2 font-medium text-white"
          >
            Send link
          </button>
        </form>
      ) : null}

      {googleEnabled ? (
        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: callbackUrl });
          }}
        >
          <button
            type="submit"
            className="w-full rounded border border-ink-300 px-4 py-2 font-medium"
          >
            Continue with Google
          </button>
        </form>
      ) : null}

      {demoEnabled ? (
        <section aria-labelledby="demo" className="space-y-3 rounded-lg border border-ink-100 p-4 dark:border-ink-700">
          <h2 id="demo" className="text-sm font-semibold uppercase tracking-widest text-ink-500">
            Demo accounts
          </h2>
          <p className="text-sm text-ink-500">
            This deployment has no mail server or Google client configured, so the three
            seeded roles sign in directly. No other address is accepted, and these
            accounts hold no real data.
          </p>
          {DEMO_ACCOUNTS.map((account) => (
            <form
              key={account.email}
              action={async () => {
                'use server';
                await signIn('dev-login', { email: account.email, redirectTo: callbackUrl });
              }}
            >
              <button
                type="submit"
                className="w-full rounded border border-ink-300 px-4 py-2 text-left text-sm"
              >
                <span className="font-mono">{account.email}</span>
                <span className="block text-ink-500">{account.label}</span>
              </button>
            </form>
          ))}
        </section>
      ) : null}

      {!emailEnabled && !googleEnabled && !demoEnabled ? (
        <p className="text-sm text-ink-500">
          No sign-in provider is configured for this deployment.
        </p>
      ) : null}
    </div>
  );
}
