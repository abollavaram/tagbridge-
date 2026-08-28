import { GENERATED_AUTH_SECRET } from './generated-secret';

/**
 * The session-signing secret.
 *
 * `AUTH_SECRET` when configured, otherwise the constant written by
 * `scripts/generate-auth-secret.ts`, which runs on `postinstall` so the module
 * exists before anything typechecks or builds. Only server and edge bundles
 * import this; nothing here reaches the browser.
 */
export function authSecret(): string {
  const configured = process.env.AUTH_SECRET;
  if (configured) return configured;
  if (GENERATED_AUTH_SECRET) return GENERATED_AUTH_SECRET;

  // Signing sessions with an empty string would be worse than not starting.
  throw new Error(
    'No session secret is available. Set AUTH_SECRET, or run ' +
      '`pnpm install` so the build-time secret is generated.',
  );
}
