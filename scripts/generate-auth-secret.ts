/**
 * Generates the session-signing secret used when AUTH_SECRET is not set.
 *
 * A deployment with no environment variables still has to sign session cookies
 * with something unpredictable. This writes a random constant at build time
 * into a module only the server and edge bundles import. The file is never
 * committed, so every build that lacks AUTH_SECRET gets a fresh one and
 * existing sessions stop validating — which is the correct trade for a demo
 * and the reason a real deployment should set AUTH_SECRET.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const TARGET = path.join(process.cwd(), 'lib', 'auth', 'generated-secret.ts');

function main(): void {
  if (process.env.AUTH_SECRET) {
    writeFileSync(
      TARGET,
      '// Generated. AUTH_SECRET is set in the environment, so this is unused.\n' +
        "export const GENERATED_AUTH_SECRET = '';\n",
    );
    console.log('auth secret: using AUTH_SECRET from the environment');
    return;
  }
  if (existsSync(TARGET)) {
    console.log('auth secret: keeping the existing generated secret');
    return;
  }
  const secret = randomBytes(32).toString('base64');
  writeFileSync(
    TARGET,
    '// Generated at build time because AUTH_SECRET was not set. Not committed.\n' +
      `export const GENERATED_AUTH_SECRET = '${secret}';\n`,
  );
  console.log('auth secret: generated a build-time secret');
}

main();
