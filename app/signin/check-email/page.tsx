export const metadata = { title: 'Check your email' };

export default function CheckEmailPage() {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Check your email</h1>
      <p className="text-ink-700 dark:text-ink-300">
        If that address has an account, a sign-in link is on its way. The link expires
        in 24 hours and can be used once.
      </p>
    </div>
  );
}
