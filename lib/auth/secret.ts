import { GENERATED_AUTH_SECRET } from './generated-secret';

/**
 * The session-signing secret.
 *
 * AUTH_SECRET when it is configured, otherwise the build-time constant. Only
 * server and edge bundles import this; nothing here reaches the browser.
 */
export function authSecret(): string {
  return process.env.AUTH_SECRET || GENERATED_AUTH_SECRET;
}
