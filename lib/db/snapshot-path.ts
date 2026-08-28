import path from 'node:path';

/**
 * Where the build-time database snapshot lives.
 *
 * Resolved from the working directory rather than from `import.meta.url`: the
 * bundler treats a URL relative to this module as a module specifier, and the
 * file has to stay a plain asset so `outputFileTracingIncludes` can carry it
 * into the deployed function.
 */
export const SNAPSHOT_PATH = path.join(process.cwd(), 'lib', 'db', 'snapshot.tar.gz');
