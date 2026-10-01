import { randomBytes } from 'node:crypto';
import { ConflictError } from '@sold/commerce';
import { eq, schema, type PrimaryDb } from '@sold/db';
import { recordAudit } from './audit';
import { emailSchema, type AuthService, type UserRecord } from './auth';

export interface BootstrapResult {
  user: UserRecord;
  created: boolean;
  /** The generated password, shown once. Null when the account already existed or a password was supplied. */
  generatedPassword: string | null;
}

/**
 * Make sure an owner exists (first-run setup, recovery). Idempotent: re-running with the same email never changes an existing
 * password and never creates a second account. A customer account is never silently promoted to staff.
 */
export async function bootstrapOwner(
  db: PrimaryDb,
  auth: AuthService,
  input: { email: string; name?: string; password?: string },
): Promise<BootstrapResult> {
  const email = emailSchema.parse(input.email);
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    if (existing.kind !== 'staff')
      throw new ConflictError(
        'email_in_use_by_customer',
        'That email belongs to a customer account; use a different address for the owner',
      );
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.userRoles)
        .values({ userId: existing.id, roleName: 'owner', grantedBy: 'cli' })
        .onConflictDoNothing();
      await tx
        .update(schema.users)
        .set({ status: 'active' })
        .where(eq(schema.users.id, existing.id));
      await recordAudit(tx, {
        actorId: null,
        actorLabel: 'cli',
        action: 'owner.ensured',
        targetType: 'user',
        targetId: existing.id,
      });
    });
    return {
      user: { id: existing.id, email, name: existing.name, kind: 'staff', status: 'active' },
      created: false,
      generatedPassword: null,
    };
  }
  const generated = input.password === undefined ? randomBytes(18).toString('base64url') : null;
  const user = await auth.createStaff(db, {
    email,
    name: input.name ?? 'Owner',
    password: input.password ?? (generated as string),
    roles: ['owner'],
    actor: { id: null, label: 'cli' },
  });
  return { user, created: true, generatedPassword: generated };
}
