import { openMigrated } from '@sold/commerce/testing';
import { schema, sql, type Db } from '@sold/db';
import { createTestDatabase, type TestDatabase } from '@sold/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from './auth';
import { hashPassword } from './password';
import { RoleService } from './roles';
import { SessionService } from './session';
import { AuthThrottle } from './throttle';

let testDb: TestDatabase;
let db: Db;
const fast = { N: 2 ** 12, r: 8, p: 1 };
const sessions = new SessionService();
const auth = new AuthService(sessions, new AuthThrottle());
const roles = new RoleService();
const actor = { id: null, label: 'test' };
const PW = 'a long enough passphrase';
let n = 0;
const email = () => `user${++n}-${Math.random().toString(36).slice(2, 7)}@example.com`;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = await openMigrated(testDb.url, 10);
});
afterAll(async () => {
  await db?.close();
  await testDb?.destroy();
});

const rows = async <T>(q: ReturnType<typeof sql>) =>
  (await db.primary.execute<T & Record<string, unknown>>(q)).rows;

describe('customers', () => {
  it('register, then log in; email is case-insensitive; duplicates are refused; the password is never stored in clear', async () => {
    const e = email();
    const u = await auth.registerCustomer(db.primary, {
      email: ` ${e.toUpperCase()} `,
      password: PW,
      name: 'Sam',
    });
    expect(u).toMatchObject({ email: e, kind: 'customer', status: 'active' });
    await expect(
      auth.registerCustomer(db.primary, { email: e, password: PW }),
    ).rejects.toMatchObject({ code: 'email_taken' });
    const login = await auth.login(
      db.primary,
      { email: e.toUpperCase(), password: PW },
      { kind: 'customer', ip: '10.0.0.1' },
    );
    expect(login.user.id).toBe(u.id);
    const [stored] = await rows<{ password_hash: string }>(
      sql`SELECT password_hash FROM users WHERE id = ${u.id}`,
    );
    expect(stored?.password_hash).toMatch(/^scrypt\$/);
    expect(stored?.password_hash).not.toContain(PW);
  });

  it('weak passwords and bad emails are refused', async () => {
    await expect(
      auth.registerCustomer(db.primary, { email: email(), password: 'short' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      auth.registerCustomer(db.primary, { email: 'not-an-email', password: PW }),
    ).rejects.toThrow();
  });

  it('every login failure looks identical: wrong password, unknown user, disabled, wrong account kind, SSO-only', async () => {
    const e = email();
    const u = await auth.registerCustomer(db.primary, { email: e, password: PW });
    const disabled = await auth.registerCustomer(db.primary, { email: email(), password: PW });
    await auth.setStatus(db.primary, disabled.id, 'disabled', actor);
    const sso = (
      await db.primary.insert(schema.users).values({ email: email(), kind: 'customer' }).returning()
    )[0]!;
    const attempts = [
      { email: e, password: 'wrong password here' },
      { email: email(), password: PW },
      { email: disabled.email, password: PW },
      { email: sso.email, password: PW },
    ];
    for (const a of attempts)
      await expect(auth.login(db.primary, a, { kind: 'customer' })).rejects.toMatchObject({
        code: 'invalid_credentials',
        status: 401,
        message: 'Incorrect email or password',
      });
    // a customer cannot sign in to the staff console with the right password
    await expect(
      auth.login(db.primary, { email: e, password: PW }, { kind: 'staff' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(u.id).toBeDefined();
  });

  it('upgrades a weaker stored hash at login', async () => {
    const e = email();
    const [u] = await db.primary
      .insert(schema.users)
      .values({ email: e, kind: 'customer', passwordHash: await hashPassword(PW, fast) })
      .returning();
    await auth.login(db.primary, { email: e, password: PW }, { kind: 'customer' });
    const [after] = await rows<{ password_hash: string }>(
      sql`SELECT password_hash FROM users WHERE id = ${u!.id}`,
    );
    expect(after?.password_hash).toMatch(/^scrypt\$32768\$8\$3\$/);
  });
});

describe('brute-force throttling', () => {
  it('locks the account after 5 failures, even for the right password, and a locked account answers 429 with Retry-After data', async () => {
    const e = email();
    await auth.registerCustomer(db.primary, { email: e, password: PW });
    for (let i = 0; i < 5; i++)
      await expect(
        auth.login(
          db.primary,
          { email: e, password: 'nope nope nope' },
          { kind: 'customer', ip: '10.9.9.9' },
        ),
      ).rejects.toMatchObject({ code: 'invalid_credentials' });
    const locked = await auth
      .login(db.primary, { email: e, password: PW }, { kind: 'customer', ip: '10.9.9.9' })
      .catch((x: unknown) => x);
    expect(locked).toMatchObject({ code: 'too_many_attempts', status: 429 });
    expect((locked as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    // the lock is on the account: another address cannot bypass it
    await expect(
      auth.login(db.primary, { email: e, password: PW }, { kind: 'customer', ip: '10.1.1.1' }),
    ).rejects.toMatchObject({ code: 'too_many_attempts' });
  });

  it('concurrent guesses cannot race past the limit', async () => {
    const e = email();
    await auth.registerCustomer(db.primary, { email: e, password: PW });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        auth.login(db.primary, { email: e, password: 'nope nope nope' }, { kind: 'customer' }),
      ),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    const [t] = await rows<{ failures: number; locked: boolean }>(
      sql`SELECT failures, locked_until > now() AS locked FROM auth_throttle WHERE key LIKE 'acct:%' ORDER BY window_start DESC LIMIT 1`,
    );
    expect(t?.locked).toBe(true);
    await expect(
      auth.login(db.primary, { email: e, password: PW }, { kind: 'customer' }),
    ).rejects.toMatchObject({ code: 'too_many_attempts' });
  });

  it('a success resets the account counter; one address cannot lock out strangers with a few failures', async () => {
    const e = email();
    await auth.registerCustomer(db.primary, { email: e, password: PW });
    for (let i = 0; i < 4; i++)
      await auth
        .login(db.primary, { email: e, password: 'nope nope nope' }, { kind: 'customer' })
        .catch(() => undefined);
    await auth.login(db.primary, { email: e, password: PW }, { kind: 'customer' });
    for (let i = 0; i < 4; i++)
      await auth
        .login(db.primary, { email: e, password: 'nope nope nope' }, { kind: 'customer' })
        .catch(() => undefined);
    await expect(
      auth.login(db.primary, { email: e, password: PW }, { kind: 'customer' }),
    ).resolves.toBeDefined();
  });
});

describe('sessions', () => {
  it('stores only a hash, resolves with permissions, and dies on revoke', async () => {
    const e = email();
    const staff = await auth.createStaff(db.primary, {
      email: e,
      name: 'Ops',
      password: PW,
      roles: ['order-manager'],
      actor,
    });
    const { token } = await auth.login(db.primary, { email: e, password: PW }, { kind: 'staff' });
    const stored = await rows<{ token_hash: string }>(
      sql`SELECT token_hash FROM sessions WHERE user_id = ${staff.id}`,
    );
    expect(stored[0]?.token_hash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
    const s = await sessions.resolve(db.primary, token);
    expect(s?.user.permissions).toEqual(expect.arrayContaining(['orders:*', 'payments:refund']));
    expect(s?.user.kind).toBe('staff');
    await sessions.revoke(db.primary, token);
    expect(await sessions.resolve(db.primary, token)).toBeNull();
  });

  it('garbage, expired and disabled-user sessions do not resolve', async () => {
    for (const t of [null, undefined, '', 'x', 'a'.repeat(500)])
      expect(await sessions.resolve(db.primary, t as string)).toBeNull();
    const e = email();
    const u = await auth.registerCustomer(db.primary, { email: e, password: PW });
    const { token } = await auth.login(
      db.primary,
      { email: e, password: PW },
      { kind: 'customer' },
    );
    expect(await sessions.resolve(db.primary, token)).not.toBeNull();
    await db.primary.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = ${u.id}`,
    );
    expect(await sessions.resolve(db.primary, token)).toBeNull();
    const e2 = email();
    const u2 = await auth.registerCustomer(db.primary, { email: e2, password: PW });
    const t2 = (await auth.login(db.primary, { email: e2, password: PW }, { kind: 'customer' }))
      .token;
    await db.primary.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${u2.id}`); // even a direct write
    expect(await sessions.resolve(db.primary, t2)).toBeNull();
  });

  it('staff sessions slide on activity but never beyond the absolute cap', async () => {
    const e = email();
    const u = await auth.createStaff(db.primary, {
      email: e,
      name: 'S',
      password: PW,
      roles: ['support'],
      actor,
    });
    const { token } = await auth.login(db.primary, { email: e, password: PW }, { kind: 'staff' });
    await db.primary.execute(
      sql`UPDATE sessions SET last_seen_at = now() - interval '5 minutes' WHERE user_id = ${u.id}`,
    );
    const slid = await sessions.resolve(db.primary, token);
    expect(slid).not.toBeNull();
    await db.primary.execute(
      sql`UPDATE sessions SET created_at = now() - interval '13 hours' WHERE user_id = ${u.id}`,
    );
    expect(await sessions.resolve(db.primary, token)).toBeNull(); // 12 h absolute cap for staff
  });

  it('changing a password signs out every other session but keeps the current one', async () => {
    const e = email();
    const u = await auth.registerCustomer(db.primary, { email: e, password: PW });
    const a = await auth.login(db.primary, { email: e, password: PW }, { kind: 'customer' });
    const b = await auth.login(db.primary, { email: e, password: PW }, { kind: 'customer' });
    await auth.changePassword(db.primary, u.id, PW, 'a different long passphrase', a.token);
    expect(await sessions.resolve(db.primary, a.token)).not.toBeNull();
    expect(await sessions.resolve(db.primary, b.token)).toBeNull();
    await expect(
      auth.login(db.primary, { email: e, password: PW }, { kind: 'customer' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(
      auth.changePassword(
        db.primary,
        u.id,
        'wrong current one',
        'another long passphrase!',
        undefined,
      ),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('disabling a user ends their sessions at once; the sweep removes expired rows', async () => {
    const e = email();
    const u = await auth.registerCustomer(db.primary, { email: e, password: PW });
    const { token } = await auth.login(
      db.primary,
      { email: e, password: PW },
      { kind: 'customer' },
    );
    await auth.setStatus(db.primary, u.id, 'disabled', actor);
    expect(await sessions.resolve(db.primary, token)).toBeNull();
    expect((await rows(sql`SELECT 1 FROM sessions WHERE user_id = ${u.id}`)).length).toBe(0);
    await db.primary
      .insert(schema.sessions)
      .values({ userId: u.id, tokenHash: 'x'.repeat(64), expiresAt: new Date(Date.now() - 1000) });
    expect(await sessions.sweepExpired(db.primary)).toBeGreaterThanOrEqual(1);
  });
});

describe('roles and permissions', () => {
  it('assigning needs a staff account, forces re-authentication, and is audited', async () => {
    const staffEmail = email();
    const staff = await auth.createStaff(db.primary, {
      email: staffEmail,
      name: 'S',
      password: PW,
      roles: ['support'],
      actor,
    });
    const { token } = await auth.login(
      db.primary,
      { email: staffEmail, password: PW },
      { kind: 'staff' },
    );
    await roles.assign(db.primary, staff.id, 'catalog-manager', actor);
    expect(await sessions.resolve(db.primary, token)).toBeNull(); // permissions changed: sign in again
    const customer = await auth.registerCustomer(db.primary, { email: email(), password: PW });
    await expect(roles.assign(db.primary, customer.id, 'admin', actor)).rejects.toMatchObject({
      code: 'not_staff',
    });
    await expect(roles.assign(db.primary, staff.id, 'nope', actor)).rejects.toMatchObject({
      code: 'not_found',
    });
    const audit = await rows<{ action: string }>(
      sql`SELECT action FROM audit_log WHERE target_id = ${staff.id} ORDER BY at`,
    );
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['user.created', 'role.assigned']),
    );
  });

  it('the last active owner can never be removed, even by two concurrent attempts', async () => {
    await db.primary.execute(sql`DELETE FROM user_roles WHERE role_name = 'owner'`);
    const a = await auth.createStaff(db.primary, {
      email: email(),
      name: 'A',
      password: PW,
      roles: ['owner'],
      actor,
    });
    const b = await auth.createStaff(db.primary, {
      email: email(),
      name: 'B',
      password: PW,
      roles: ['owner'],
      actor,
    });
    const results = await Promise.allSettled([
      roles.revoke(db.primary, a.id, 'owner', actor),
      roles.revoke(db.primary, b.id, 'owner', actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'last_owner' },
    });
    const left = await rows<{ n: string }>(
      sql`SELECT count(*) AS n FROM user_roles WHERE role_name = 'owner'`,
    );
    expect(Number(left[0]?.n)).toBe(1);
  });

  it('custom roles: known permissions only, never the wildcard, built-ins cannot be deleted', async () => {
    await roles.create(
      db.primary,
      { name: 'stock-clerk', permissions: ['catalog:read', 'catalog:write'] },
      actor,
    );
    await expect(
      roles.create(db.primary, { name: 'stock-clerk', permissions: ['catalog:read'] }, actor),
    ).rejects.toMatchObject({ code: 'role_exists' });
    await expect(
      roles.create(db.primary, { name: 'bad', permissions: ['catalog:destroy'] }, actor),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      roles.create(db.primary, { name: 'god', permissions: ['*'] }, actor),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      roles.create(db.primary, { name: 'Bad Name', permissions: ['catalog:read'] }, actor),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(roles.delete(db.primary, 'owner', actor)).rejects.toMatchObject({
      code: 'role_built_in',
    });
    await roles.delete(db.primary, 'stock-clerk', actor);
  });
});

describe('audit log', () => {
  it('is append-only: the database refuses updates and deletes', async () => {
    const msg = (q: ReturnType<typeof sql>) =>
      db.primary.execute(q).then(
        () => '',
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    await auth.createStaff(db.primary, {
      email: email(),
      name: 'A',
      password: PW,
      roles: [],
      actor,
    });
    expect(await msg(sql`UPDATE audit_log SET action = 'tampered'`)).toMatch(/append-only/);
    expect(await msg(sql`DELETE FROM audit_log`)).toMatch(/append-only/);
  });

  it('a rolled-back change leaves no audit record', async () => {
    const before = await rows<{ n: string }>(sql`SELECT count(*) AS n FROM audit_log`);
    await expect(
      db.primary.transaction(async (tx) => {
        const { recordAudit } = await import('./audit');
        await recordAudit(tx, { actorId: null, actorLabel: 'x', action: 'will.rollback' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await rows<{ n: string }>(sql`SELECT count(*) AS n FROM audit_log`);
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});
