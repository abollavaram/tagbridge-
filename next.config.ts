import type { NextConfig } from 'next';

/**
 * PGlite holds an exclusive lock on its data directory, and Next spawns
 * several worker processes for static generation. With a real DATABASE_URL
 * that is fine — Postgres handles the concurrency — but on the local fallback
 * two workers race for the same directory and a prerender fails intermittently.
 * One worker, only when there is no database URL to talk to.
 */
const usesLocalPglite = !process.env.DATABASE_URL;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  ...(usesLocalPglite ? { experimental: { cpus: 1, workerThreads: false } } : {}),
  poweredByHeader: false,
  // PGlite ships its extensions as tarball assets loaded at runtime; bundling
  // them rewrites the paths and the extension then cannot be found.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    'postgres',
    'pino',
  ],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
