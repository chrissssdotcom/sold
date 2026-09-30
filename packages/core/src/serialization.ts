/**
 * JSON-safe encoding for values that plain JSON cannot carry: `bigint` (money in minor units) and `Date`.
 * Job payloads, webhook bodies and outbox rows go through this so a Money value survives the queue.
 */
export type JsonSafe = null | boolean | number | string | JsonSafe[] | { [key: string]: JsonSafe };

export function toJsonSafe(value: unknown): JsonSafe {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    const out: { [key: string]: JsonSafe } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toJsonSafe(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError('Cannot encode a non-finite number');
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    return value;
  throw new TypeError(`Cannot encode a value of type ${typeof value}`);
}

export function fromJsonSafe<T = unknown>(value: JsonSafe): T {
  return revive(value) as T;
}

function revive(value: JsonSafe): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$bigint' && typeof value.$bigint === 'string')
      return BigInt(value.$bigint);
    if (keys.length === 1 && keys[0] === '$date' && typeof value.$date === 'string')
      return new Date(value.$date);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
  }
  return value;
}
