import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'TagBridge — industrial connectivity software',
    template: '%s · TagBridge',
  },
  description:
    'OPC servers, protocol gateways, historian connectors and MQTT bridges, with search that understands how control engineers describe a problem.',
  openGraph: {
    title: 'TagBridge — industrial connectivity software',
    description:
      'Search by the problem you have, not the part number you do not know yet.',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-signal-600 focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        <header className="border-b border-ink-100/60 dark:border-ink-700">
          <nav
            aria-label="Primary"
            className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4"
          >
            <Link href="/" className="font-mono text-lg font-semibold tracking-tight">
              TagBridge
            </Link>
            <ul className="flex items-center gap-6 text-sm">
              <li>
                <Link href="/account" className="hover:underline">
                  Account
                </Link>
              </li>
              <li>
                <Link href="/signin" className="hover:underline">
                  Sign in
                </Link>
              </li>
            </ul>
          </nav>
        </header>
        <main id="main" className="mx-auto max-w-5xl px-6 py-12">
          {children}
        </main>
        <footer className="mx-auto max-w-5xl px-6 py-12 text-sm text-ink-500">
          <p>
            TagBridge is a portfolio project. The vendor, the catalog and every product
            description in it were written for this build.
          </p>
        </footer>
      </body>
    </html>
  );
}
