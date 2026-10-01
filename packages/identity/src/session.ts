import { schema, sql, eq, type PrimaryDb } from '@sold/db';
import { hashToken, newToken } from './tokens';

export type UserKind = 'customer' | 'staff';

export interface SessionPolicy {
  /** Sliding window: how long a session survives without activity. */
  idleSeconds: number;
  /** Hard cap from creation, however active. */
  absoluteSeconds: number;
}

export const defaultSessionPolicy: Record<UserKind, SessionPolicy> = {
  customer: { idleSeconds: 30 * 86_400, absoluteSeconds: 90 * 86_400 },
  staff: { idleSeconds: 2 * 3_600, absoluteSeconds: 12 * 3_600 },
};

export interface ResolvedUser {
  id: string;
  email: string;
  name: string;
  kind: UserKind;
  permissions: string[];
}

export interface ResolvedSession {
  sessionId: string;
  user: ResolvedUser;
  expiresAt: Date;
}

interface Row extends Record<string, unknown> {
  session_id: string;
  user_id: string;
  email: string;
  name: string;
  kind: UserKind;
  expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
  permissions: string[];
}

/**
 * Opaque server-side sessions. The cookie holds 256 random bits; only its SHA-256 is stored, so reading the database
 * never yields a usable session. Staff sessions are short and idle out quickly; customers' last long. A disabled user's
 * sessions stop resolving immediately (status is checked on every request, not baked into the session).
 */
export class SessionService {
  constructor(
    private readonly policy: Record<UserKind, SessionPolicy> = defaultSessionPolicy,
    /** Re-write `last_seen`/expiry at most this often, so a busy session is not an UPDATE per request. */
    private readonly touchEverySeconds = 60,
  ) {}

  async create(
    db: PrimaryDb,
    userId: string,
    kind: UserKind,
    meta: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(Date.now() + this.policy[kind].idleSeconds * 1000);
    await db.insert(schema.sessions).values({
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    });
    return { token, expiresAt };
  }

  /** One indexed query resolves session, user and the union of their roles' permissions. */
  async resolve(db: PrimaryDb, token: string | null | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length < 20 || token.length > 100) return null;
    const row = (
      await db.execute<Row>(sql`
        SELECT s.id AS session_id, u.id AS user_id, u.email, u.name, u.kind, s.expires_at, s.created_at, s.last_seen_at,
               COALESCE((SELECT array_agg(DISTINCT p) FROM user_roles ur
                         JOIN roles r ON r.name = ur.role_name, unnest(r.permissions) AS p
                         WHERE ur.user_id = u.id), '{}') AS permissions
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ${hashToken(token)} AND s.expires_at > now() AND u.status = 'active'`)
    ).rows[0];
    if (!row) return null;
    const pol = this.policy[row.kind];
    // Raw query results carry timestamps as strings.
    const createdAt = new Date(row.created_at);
    const lastSeenAt = new Date(row.last_seen_at);
    const absolute = new Date(createdAt.getTime() + pol.absoluteSeconds * 1000);
    if (absolute.getTime() <= Date.now()) return null;
    let expiresAt = new Date(row.expires_at);
    if (Date.now() - lastSeenAt.getTime() > this.touchEverySeconds * 1000) {
      expiresAt = new Date(Math.min(absolute.getTime(), Date.now() + pol.idleSeconds * 1000));
      await db
        .update(schema.sessions)
        .set({ lastSeenAt: new Date(), expiresAt })
        .where(eq(schema.sessions.id, row.session_id));
    }
    return {
      sessionId: row.session_id,
      expiresAt,
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        kind: row.kind,
        permissions: row.permissions,
      },
    };
  }

  async revoke(db: PrimaryDb, token: string): Promise<void> {
    await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
  }

  /** Sign a user out everywhere (password change, role change, account disabled). Optionally keep the current session. */
  async revokeAll(db: PrimaryDb, userId: string, keepToken?: string): Promise<number> {
    const res = await db.execute(sql`
      DELETE FROM sessions WHERE user_id = ${userId} ${keepToken ? sql`AND token_hash <> ${hashToken(keepToken)}` : sql``} RETURNING id`);
    return res.rows.length;
  }

  async sweepExpired(db: PrimaryDb, limit = 5_000): Promise<number> {
    const res = await db.execute(sql`
      DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < now() ORDER BY expires_at LIMIT ${limit}) RETURNING id`);
    return res.rows.length;
  }
}
