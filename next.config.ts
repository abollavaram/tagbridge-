import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The database snapshot is a plain asset the server reads at runtime, so the
  // tracer has to be told to carry it into the deployed function.
  outputFileTracingIncludes: {
    '/**': ['./lib/db/snapshot.tar.gz'],
  },
  poweredByHeader: false,
  // PGlite ships its extensions as tarball assets loaded at runtime; bundling
  // them rewrites the paths and the extension then cannot be found.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@electric-sql/pglite-pgvector',
    'postgres',
    'pino',
  ],
  async rewrites() {
    return [
      // Agent-native discovery lives at well-known paths by convention. The
      // App Router will not route a directory whose name starts with a dot,
      // so the handlers live under /api and the well-known paths rewrite onto
      // them — which also keeps the published URL stable if the handler moves.
      { source: '/.well-known/ucp', destination: '/api/ucp' },
      { source: '/.well-known/agentic-commerce', destination: '/api/acp' },
    ];
  },
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
