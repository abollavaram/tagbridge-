export const metadata = { title: 'Not permitted' };

export default function ForbiddenPage() {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">Not permitted</h1>
      <p className="text-ink-700 dark:text-ink-300">
        Your account does not have access to that area.
      </p>
    </div>
  );
}
