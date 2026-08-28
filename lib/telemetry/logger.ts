import pino from 'pino';
import { getEnv } from '@/lib/env';

/**
 * Structured JSON logs.
 *
 * Redaction is declared here rather than at each call site: nothing that can
 * identify a customer should reach a log line, and relying on discipline at
 * hundreds of call sites is not a control.
 */
export const logger = pino({
  level: getEnv().LOG_LEVEL,
  redact: {
    paths: [
      'email',
      '*.email',
      '*.*.email',
      'name',
      '*.name',
      'companyName',
      '*.companyName',
      'password',
      '*.password',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  base: { service: 'tagbridge' },
});

export function requestLogger(requestId: string) {
  return logger.child({ requestId });
}

/** Stable request id, taken from the platform header when there is one. */
export function requestIdFrom(headers: Headers): string {
  return (
    headers.get('x-request-id') ??
    headers.get('x-vercel-id') ??
    globalThis.crypto.randomUUID()
  );
}
