import { createHash } from 'node:crypto';
import { sql } from '@sold/db';
import type { DbOrTx } from '@sold/commerce';
import { AccountLockedError } from './errors';

export interface ThrottleKey {
  key: string;
  /** Failures within the window before the key locks. */
  max: number;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** Account key (strict) and source-address key (looser: shared NATs exist). Hashed: no email or IP at rest in this table. */
export function throttleKeys(
  email: string,
  ip: string | null | undefined,
  opts: { accountMax?: number; ipMax?: number } = {},
): ThrottleKey[] {
  const keys: ThrottleKey[] = [
    { key: `acct:${hash(email.toLowerCase())}`, max: opts.accountMax ?? 5 },
  ];
  if (ip) keys.push({ key: `ip:${hash(ip)}`, max: opts.ipMax ?? 30 });
  return keys;
}

export class AuthThrottle {
  constructor(private readonly windowSeconds = 900) {}

  /** Throws `AccountLockedError` (429 + retry-after) if any key is currently locked. */
  async assertAllowed(db: DbOrTx, keys: readonly ThrottleKey[]): Promise<void> {
    if (keys.length === 0) return;
    const rows = (
      await db.execute<{ wait: string | null }>(sql`
        SELECT max(ceil(extract(epoch FROM locked_until - now())))::text AS wait
        FROM auth_throttle
        WHERE key IN (${sql.join(
          keys.map((k) => sql`${k.key}`),
          sql`, `,
        )}) AND locked_until > now()`)
    ).rows;
    const wait = Number(rows[0]?.wait ?? 0);
    if (wait > 0) throw new AccountLockedError(wait);
  }

  /** Atomic: concurrent attempts cannot race past the limit. Lock time doubles with each failure beyond it (cap 1 h). */
  async recordFailure(db: DbOrTx, keys: readonly ThrottleKey[]): Promise<void> {
    for (const { key, max } of keys) {
      await db.execute(sql`
        INSERT INTO auth_throttle (key, failures, window_start) VALUES (${key}, 1, now())
        ON CONFLICT (key) DO UPDATE SET
          failures = CASE WHEN auth_throttle.window_start < now() - make_interval(secs => ${this.windowSeconds})
                          THEN 1 ELSE auth_throttle.failures + 1 END,
          window_start = CASE WHEN auth_throttle.window_start < now() - make_interval(secs => ${this.windowSeconds})
                              THEN now() ELSE auth_throttle.window_start END,
          locked_until = CASE
            WHEN (CASE WHEN auth_throttle.window_start < now() - make_interval(secs => ${this.windowSeconds})
                       THEN 1 ELSE auth_throttle.failures + 1 END) >= ${max}
            THEN now() + make_interval(secs => least(3600, 60 * power(2, (CASE WHEN auth_throttle.window_start < now() - make_interval(secs => ${this.windowSeconds})
                       THEN 1 ELSE auth_throttle.failures + 1 END) - ${max})))
            ELSE auth_throttle.locked_until END`);
    }
  }

  /** A successful login clears the ACCOUNT key only: a shared address must not be able to wash away its own failures. */
  async reset(db: DbOrTx, keys: readonly ThrottleKey[]): Promise<void> {
    const acct = keys.filter((k) => k.key.startsWith('acct:'));
    for (const { key } of acct) await db.execute(sql`DELETE FROM auth_throttle WHERE key = ${key}`);
  }
}
