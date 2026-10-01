import { ConflictError, NotFoundError, ValidationError } from '@sold/commerce';
import { eq, schema, sql, type PrimaryDb } from '@sold/db';
import { recordAudit } from './audit';
import { isKnownPermission, permissionSchema } from './rbac';

export interface Actor {
  id: string | null;
  label: string;
}

const NAME = /^[a-z][a-z0-9-]{1,40}$/;

export class RoleService {
  constructor(private readonly extensionPermissions: () => readonly string[] = () => []) {}

  async list(db: PrimaryDb) {
    return db.select().from(schema.roles).orderBy(schema.roles.name);
  }

  async create(
    db: PrimaryDb,
    input: { name: string; description?: string; permissions: string[] },
    actor: Actor,
  ): Promise<void> {
    if (!NAME.test(input.name))
      throw new ValidationError('Role names are lowercase letters, digits and dashes');
    const permissions = [...new Set(input.permissions.map((p) => permissionSchema.parse(p)))];
    const unknown = permissions.filter((p) => !isKnownPermission(p, this.extensionPermissions()));
    if (unknown.length > 0) throw new ValidationError('Unknown permissions', { unknown });
    // Only an owner-level actor may mint a role containing `*`; custom roles never get the wildcard.
    if (permissions.includes('*'))
      throw new ValidationError('Custom roles cannot grant everything');
    await db.transaction(async (tx) => {
      const r = await tx
        .insert(schema.roles)
        .values({ name: input.name, description: input.description ?? '', permissions })
        .onConflictDoNothing()
        .returning({ name: schema.roles.name });
      if (r.length === 0)
        throw new ConflictError('role_exists', 'A role with that name already exists');
      await recordAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.label,
        action: 'role.created',
        targetType: 'role',
        targetId: input.name,
        detail: { permissions },
      });
    });
  }

  async delete(db: PrimaryDb, name: string, actor: Actor): Promise<void> {
    await db.transaction(async (tx) => {
      const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.name, name));
      if (!role) throw new NotFoundError('Role', name);
      if (role.builtIn)
        throw new ConflictError('role_built_in', 'Built-in roles cannot be deleted');
      await tx.delete(schema.roles).where(eq(schema.roles.name, name));
      await recordAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.label,
        action: 'role.deleted',
        targetType: 'role',
        targetId: name,
      });
    });
  }

  async assign(db: PrimaryDb, userId: string, roleName: string, actor: Actor): Promise<void> {
    await db.transaction(async (tx) => {
      const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.name, roleName));
      if (!role) throw new NotFoundError('Role', roleName);
      const [user] = await tx
        .select({ kind: schema.users.kind })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (!user) throw new NotFoundError('User', userId);
      // Customers never hold roles: a role is a staff concept, and a customer account is self-registered.
      if (user.kind !== 'staff')
        throw new ConflictError('not_staff', 'Only staff accounts can hold roles');
      await tx
        .insert(schema.userRoles)
        .values({ userId, roleName, grantedBy: actor.label })
        .onConflictDoNothing();
      await recordAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.label,
        action: 'role.assigned',
        targetType: 'user',
        targetId: userId,
        detail: { role: roleName },
      });
    });
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`); // permissions changed: re-authenticate
  }

  /** Remove a role from a user. The last active owner can never be removed: the instance must stay administrable. */
  async revoke(db: PrimaryDb, userId: string, roleName: string, actor: Actor): Promise<void> {
    await db.transaction(async (tx) => {
      if (roleName === 'owner') {
        // Lock every owner grant so two concurrent revokes cannot both see "another owner exists".
        const owners = (
          await tx.execute<{ user_id: string }>(sql`
            SELECT ur.user_id FROM user_roles ur JOIN users u ON u.id = ur.user_id
            WHERE ur.role_name = 'owner' AND u.status = 'active' FOR UPDATE OF ur`)
        ).rows;
        if (owners.length <= 1 && owners.some((o) => o.user_id === userId))
          throw new ConflictError('last_owner', 'There must always be at least one active owner');
      }
      const r = await tx.execute(
        sql`DELETE FROM user_roles WHERE user_id = ${userId} AND role_name = ${roleName} RETURNING role_name`,
      );
      if (r.rows.length === 0) return;
      await recordAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.label,
        action: 'role.revoked',
        targetType: 'user',
        targetId: userId,
        detail: { role: roleName },
      });
    });
    await db.execute(sql`DELETE FROM sessions WHERE user_id = ${userId}`);
  }
}
