import { eq, schema, sql, and, type PrimaryDb } from '@sold/db';
import { recordAudit } from './audit';
import { SsoError, type OidcConfig, type OidcIdentity } from './oidc';
import type { SessionService } from './session';

export interface SsoSignIn {
  userId: string;
  email: string;
  token: string;
  expiresAt: Date;
  provisioned: boolean;
}

/**
 * Turn a verified identity into a Sold staff session, applying the provisioning rules. The stable key is
 * `(provider, subject)`, never the email; an email is only ever used to link when the IdP asserts it is VERIFIED and the
 * operator has opted in (`autoLinkByEmail`). SSO never signs in a customer account or a disabled user.
 */
export async function completeSsoLogin(
  db: PrimaryDb,
  sessions: SessionService,
  cfg: Pick<
    OidcConfig,
    'allowedEmailDomains' | 'autoLinkByEmail' | 'autoProvision' | 'defaultRoles' | 'groupRoleMap'
  >,
  identity: OidcIdentity,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<SsoSignIn> {
  const domain = identity.email?.split('@')[1];
  if (cfg.allowedEmailDomains?.length && (!domain || !cfg.allowedEmailDomains.includes(domain)))
    throw new SsoError('domain_not_allowed');

  const mappedRoles = [...new Set(identity.groups.flatMap((g) => cfg.groupRoleMap?.[g] ?? []))];
  const wantedRoles = cfg.groupRoleMap ? mappedRoles : (cfg.defaultRoles ?? []);

  const result = await db.transaction(async (tx) => {
    const [link] = await tx
      .select()
      .from(schema.identityLinks)
      .where(
        and(
          eq(schema.identityLinks.provider, identity.provider),
          eq(schema.identityLinks.subject, identity.subject),
        ),
      );
    let userId: string | null = link?.userId ?? null;
    let provisioned = false;

    if (!userId) {
      if (!identity.email || !identity.emailVerified) throw new SsoError('email_unverified');
      const [existing] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, identity.email));
      if (existing) {
        if (!cfg.autoLinkByEmail || existing.kind !== 'staff')
          throw new SsoError('no_linked_account');
        userId = existing.id;
      } else {
        if (!cfg.autoProvision) throw new SsoError('not_provisioned');
        const [created] = await tx
          .insert(schema.users)
          .values({
            email: identity.email,
            name: identity.name,
            kind: 'staff',
            emailVerifiedAt: new Date(),
          })
          .returning({ id: schema.users.id });
        userId = created!.id;
        provisioned = true;
      }
      await tx.insert(schema.identityLinks).values({
        provider: identity.provider,
        subject: identity.subject,
        userId,
        email: identity.email,
      });
      await recordAudit(tx, {
        actorId: null,
        actorLabel: `sso:${identity.provider}`,
        action: provisioned ? 'user.provisioned' : 'user.linked',
        targetType: 'user',
        targetId: userId,
        detail: { provider: identity.provider },
      });
    }

    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!user || user.status !== 'active' || user.kind !== 'staff')
      throw new SsoError('account_unavailable');

    if (cfg.groupRoleMap || provisioned) {
      // Group-managed: the IdP is the source of truth for roles, applied at every sign-in. Roles must exist.
      const known = new Set(
        (await tx.select({ n: schema.roles.name }).from(schema.roles)).map((r) => r.n),
      );
      const roles = wantedRoles.filter((r) => known.has(r) && r !== 'owner'); // SSO groups can never mint an owner
      const rolesArray = roles.length
        ? sql`ARRAY[${sql.join(
            roles.map((r) => sql`${r}`),
            sql`, `,
          )}]::text[]`
        : sql`ARRAY[]::text[]`;
      if (cfg.groupRoleMap)
        await tx.execute(
          sql`DELETE FROM user_roles WHERE user_id = ${userId} AND granted_by = ${`sso:${identity.provider}`} AND role_name <> ALL(${rolesArray})`,
        );
      for (const roleName of roles)
        await tx
          .insert(schema.userRoles)
          .values({ userId, roleName, grantedBy: `sso:${identity.provider}` })
          .onConflictDoNothing();
    }
    await tx
      .update(schema.users)
      .set({ lastLoginAt: new Date() })
      .where(eq(schema.users.id, userId));
    return { userId, email: user.email, provisioned };
  });

  const session = await sessions.create(db, result.userId, 'staff', meta);
  return { ...result, ...session };
}
