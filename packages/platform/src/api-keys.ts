import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DbOrTx } from '@sold/commerce';
import { and, eq, isNull, schema, sql, type PrimaryDb } from '@sold/db';

const { apiKeys } = schema;

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface VerifiedKey {
  id: string;
  name: string;
  scopes: readonly string[];
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const SHAPE = /^sk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

/**
 * Create a key. The full token is returned ONCE (it cannot be shown again: only a hash is stored). The secret is 256 random bits,
 * so a fast hash is enough: there is nothing to brute-force, unlike a human password.
 */
export async function createApiKey(
  db: DbOrTx,
  input: { name: string; scopes: string[]; createdBy: string; expiresAt?: Date },
): Promise<{ token: string; record: ApiKeyRecord }> {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: input.name,
      prefix,
      secretHash: sha256(secret),
      scopes: [...new Set(input.scopes)],
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  if (!row) throw new Error('key insert failed');
  return { token: `sk_${prefix}_${secret}`, record: toRecord(row) };
}

/**
 * Authenticate a bearer token. Every failure looks the same to the caller (null) and costs about the same: malformed tokens,
 * unknown prefixes, wrong secrets, revoked and expired keys. `lastUsedAt` is touched at most once a minute so reads do not become writes.
 */
export async function verifyApiKey(
  db: PrimaryDb,
  token: string | null | undefined,
): Promise<VerifiedKey | null> {
  const m = token ? SHAPE.exec(token) : null;
  const prefix = m?.[1] ?? '00000000';
  const secret = m?.[2] ?? 'x'.repeat(43);
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
  const want = Buffer.from(row?.secretHash ?? sha256('no-such-key'));
  const given = Buffer.from(sha256(secret));
  const same = want.length === given.length && timingSafeEqual(want, given);
  if (
    !m ||
    !row ||
    !same ||
    row.revokedAt ||
    (row.expiresAt && row.expiresAt.getTime() <= Date.now())
  )
    return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
    void db
      .execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`)
      .catch(() => undefined);
  return { id: row.id, name: row.name, scopes: row.scopes };
}

export async function revokeApiKey(db: DbOrTx, id: string): Promise<boolean> {
  const r = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return r.length > 0;
}

export async function listApiKeys(db: DbOrTx): Promise<ApiKeyRecord[]> {
  return (
    await db
      .select()
      .from(apiKeys)
      .orderBy(sql`${apiKeys.createdAt} DESC`)
      .limit(200)
  ).map(toRecord);
}

function toRecord(r: typeof apiKeys.$inferSelect): ApiKeyRecord {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  };
}
