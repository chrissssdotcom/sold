import { createHash } from 'node:crypto';
import { fromJsonSafe, toJsonSafe, type JsonSafe } from '@sold/core';
import { sql } from '@sold/db';
import { ConflictError } from './errors';
import type { DbOrTx, Tx } from './types';

/** Stable hash of a request body: the same logical request must hash the same regardless of key order. */
export function hashRequest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(toJsonSafe(value)))
    .digest('hex');
}

function canonicalJson(v: JsonSafe): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k] as JsonSafe)}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

export interface IdempotentResult<T> {
  value: T;
  /** True when this call returned a stored response instead of running `fn`. */
  replayed: boolean;
}

/**
 * Exactly-once execution of `fn` per (scope, key), atomically with its own writes.
 *
 * The key row is inserted in the SAME transaction as `fn`'s effects, so "key exists" and "effects exist" are
 * one fact. A concurrent duplicate blocks on the primary-key lock until the first transaction ends, then reads
 * its stored response (or, if the first rolled back, runs itself). Reusing a key with a different request
 * body is a client bug and is refused, never silently answered with the wrong response.
 */
export async function runIdempotent<T>(
  db: DbOrTx,
  scope: string,
  key: string,
  request: unknown,
  fn: (tx: Tx) => Promise<T>,
): Promise<IdempotentResult<T>> {
  const requestHash = hashRequest(request);
  return db.transaction(async (tx) => {
    const inserted = await tx.execute(sql`
      INSERT INTO idempotency_keys (scope, key, request_hash) VALUES (${scope}, ${key}, ${requestHash})
      ON CONFLICT (scope, key) DO NOTHING RETURNING key`);
    if (inserted.rows.length === 0) {
      const row = (
        await tx.execute<{ request_hash: string; status: string; response: JsonSafe }>(sql`
          SELECT request_hash, status, response FROM idempotency_keys
          WHERE scope = ${scope} AND key = ${key}`)
      ).rows[0];
      if (!row || row.status !== 'completed')
        throw new ConflictError(
          'idempotency_in_progress',
          'A request with this key is in progress',
        );
      if (row.request_hash !== requestHash)
        throw new ConflictError(
          'idempotency_key_reuse',
          'This idempotency key was already used with a different request',
        );
      return { value: fromJsonSafe<T>(row.response), replayed: true };
    }
    const value = await fn(tx);
    await tx.execute(sql`
      UPDATE idempotency_keys
      SET status = 'completed', response = ${JSON.stringify(toJsonSafe(value))}::jsonb, completed_at = now()
      WHERE scope = ${scope} AND key = ${key}`);
    return { value, replayed: false };
  });
}
