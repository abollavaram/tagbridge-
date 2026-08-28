/**
 * Normalises the result of a raw `db.execute`.
 *
 * postgres-js returns the rows directly; PGlite returns a result object with a
 * `rows` property. Anything reading raw SQL goes through here so the app does
 * not silently read zero rows when the driver changes underneath it.
 */
export function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export function firstRow<T>(result: unknown): T | undefined {
  return toRows<T>(result)[0];
}
