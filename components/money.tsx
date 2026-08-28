import { formatCents } from '@/lib/commerce/pricing';

export function Money({ cents, currency = 'USD' }: { cents: number; currency?: string }) {
  return <span className="tabular-nums">{formatCents(cents, currency)}</span>;
}

export function BillingNote({ interval }: { interval: 'none' | 'monthly' | 'annual' }) {
  if (interval === 'none') return <span className="text-ink-500"> one-time</span>;
  return <span className="text-ink-500"> / {interval === 'monthly' ? 'month' : 'year'}</span>;
}
