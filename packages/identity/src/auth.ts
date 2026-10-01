import { z } from 'zod';
import { ConflictError, ValidationError } from '@sold/commerce';
import { schema, sql, eq, type PrimaryDb } from '@sold/db';
import { recordAudit } from './audit';
import { AuthThrottle, throttleKeys } from './throttle';
import { InvalidCredentialsError } from './errors';
import {
  checkPasswordPolicy,
  dummyHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password';
import type { SessionService, UserKind } from './session';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  kind: UserKind;
  status: 'active' | 'disabled';
}

const toRecord = (u: typeof schema.users.$inferSelect): UserRecord => ({
  id: u.id,
  email: u.email,
  name: u.name,
  kind: u.kind as UserKind,
  status: u.status as UserRecord['status'],
});

export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
  /** Which kind of account may sign in here: the storefront admits customers, the admin admits staff. */
  kind: UserKind;
}

/**
 * Password authentication. Failure modes are indistinguishable to the caller (one error, equal work), brute force is
 * throttled per account AND per source address, and nothing reveals whether an email is registered at login.
 */
export class AuthService {
  constructor(
    readonly sessions: SessionService,
    private readonly throttle = new AuthThrottle(),
  ) {}

  async registerCustomer(
    db: PrimaryDb,
    input: { email: string; password: string; name?: string },
  ): Promise<UserRecord> {
    const email = emailSchema.parse(input.email);
    const policy = checkPasswordPolicy(input.password, { email });
    if (!policy.ok)
      throw new ValidationError(policy.reason ?? 'Weak password', { field: 'password' });
    const passwordHash = await hashPassword(input.password);
    const inserted = await db
      .insert(schema.users)
      .values({
        email,
        name: (input.name ?? '').trim().slice(0, 120),
        kind: 'customer',
        passwordHash,
      })
      .onConflictDoNothing({ target: schema.users.email })
      .returning();
    const user = inserted[0];
    if (!user) throw new ConflictError('email_taken', 'An account with that email already exists');
    return toRecord(user);
  }

  async createStaff(
    db: PrimaryDb,
    input: {
      email: string;
      name: string;
      password?: string;
      roles: string[];
      actor: { id: string | null; label: string };
    },
  ): Promise<UserRecord> {
    const email = emailSchema.parse(input.email);
    let passwordHash: string | null = null;
    if (input.password !== undefined) {
      const policy = checkPasswordPolicy(input.password, { email });
      if (!policy.ok)
        throw new ValidationError(policy.reason ?? 'Weak password', { field: 'password' });
      passwordHash = await hashPassword(input.password);
    }
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.users)
        .values({ email, name: input.name.trim().slice(0, 120), kind: 'staff', passwordHash })
        .onConflictDoNothing({ target: schema.users.email })
        .returning();
      const user = inserted[0];
      if (!user) throw new ConflictError('email_taken', 'A user with that email already exists');
      for (const role of input.roles)
        await tx
          .insert(schema.userRoles)
          .values({ userId: user.id, roleName: role, grantedBy: input.actor.label });
      await recordAudit(tx, {
        actorId: input.actor.id,
        actorLabel: input.actor.label,
        action: 'user.created',
        targetType: 'user',
        targetId: user.id,
        detail: { kind: 'staff', roles: input.roles },
      });
      return toRecord(user);
    });
  }

  async login(
    db: PrimaryDb,
    input: { email: string; password: string },
    ctx: LoginContext,
  ): Promise<{ user: UserRecord; token: string; expiresAt: Date }> {
    const parsed = emailSchema.safeParse(input.email);
    const email = parsed.success ? parsed.data : input.email.slice(0, 254).toLowerCase();
    const keys = throttleKeys(email, ctx.ip);
    await this.throttle.assertAllowed(db, keys);

    const [row] = parsed.success
      ? await db.select().from(schema.users).where(eq(schema.users.email, email))
      : [];
    // Always do one hash verification, whether or not the account exists: equal work, equal time.
    const ok = row?.passwordHash
      ? await verifyPassword(input.password, row.passwordHash)
      : (await verifyPassword(input.password, await dummyHash()), false);
    if (!row || !ok || row.status !== 'active' || row.kind !== ctx.kind) {
      await this.throttle.recordFailure(db, keys);
      throw new InvalidCredentialsError();
    }
    await this.throttle.reset(db, keys);
    if (row.passwordHash && needsRehash(row.passwordHash))
      await db
        .update(schema.users)
        .set({ passwordHash: await hashPassword(input.password) })
        .where(eq(schema.users.id, row.id));
    await db
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, row.id));
    const session = await this.sessions.create(db, row.id, row.kind as UserKind, {
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return { user: toRecord(row), ...session };
  }

  /** Change a password (after verifying the current one) and sign out every other session. */
  async changePassword(
    db: PrimaryDb,
    userId: string,
    current: string,
    next: string,
    keepToken?: string,
  ): Promise<void> {
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!row?.passwordHash || !(await verifyPassword(current, row.passwordHash)))
      throw new InvalidCredentialsError();
    const policy = checkPasswordPolicy(next, { email: row.email });
    if (!policy.ok)
      throw new ValidationError(policy.reason ?? 'Weak password', { field: 'password' });
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(next) })
      .where(eq(schema.users.id, userId));
    await this.sessions.revokeAll(db, userId, keepToken);
  }

  async setStatus(
    db: PrimaryDb,
    userId: string,
    status: 'active' | 'disabled',
    actor: { id: string | null; label: string },
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const r = await tx
        .update(schema.users)
        .set({ status })
        .where(eq(schema.users.id, userId))
        .returning({ id: schema.users.id });
      if (r.length === 0) throw new ValidationError('Unknown user');
      if (status === 'disabled')
        await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
      await recordAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.label,
        action: `user.${status === 'disabled' ? 'disabled' : 'enabled'}`,
        targetType: 'user',
        targetId: userId,
      });
    });
  }
}
