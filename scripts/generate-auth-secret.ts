/**
 * Ensures the session-signing secret module exists.
 *
 * A deployment with no environment variables still has to sign session cookies
 * with something unpredictable. This writes a random constant into a module
 * only the server and edge bundles import. The file is never committed, so
 * every environment that lacks AUTH_SECRET gets its own and sessions do not
 * survive a redeploy — the correct trade for a demo, and the reason a real
 * deployment sets AUTH_SECRET.
 *
 * Runs on `postinstall` rather than as a build step: the module has to exist
 * before anything typechecks, and CI typechecks straight after installing.
 *
 * AUTH_SECRET is deliberately not consulted here. Writing an empty constant
 * when it happens to be set makes the result depend on which command ran last —
 * an e2e run that sets it in a subprocess would leave a later plain build with
 * no secret at all. `authSecret()` prefers the environment variable at runtime,
 * so an unused constant costs nothing.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TARGET = path.join(process.cwd(), 'lib', 'auth', 'generated-secret.ts');

function main(): void {
  if (existsSync(TARGET)) {
    console.log('auth secret: keeping the existing generated secret');
    return;
  }
  const secret = randomBytes(32).toString('base64');
  writeFileSync(
    TARGET,
    '// Generated, never committed. Used only when AUTH_SECRET is not set.\n' +
      `export const GENERATED_AUTH_SECRET = '${secret}';\n`,
  );
  console.log('auth secret: generated a build-time secret');
}

main();
