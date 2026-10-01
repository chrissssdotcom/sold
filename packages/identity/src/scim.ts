import { and, eq, schema, sql, type PrimaryDb } from '@sold/db';
import { recordAudit } from './audit';
import { emailSchema } from './auth';
import { hashToken, newToken } from './tokens';

/**
 * SCIM 2.0 (RFC 7643/7644) provisioning for staff: an identity provider creates, updates and deactivates users, and
 * maps its groups to Sold roles. Authenticated by a bearer token (only its hash is stored). SCIM never creates customers,
 * never touches the `owner` role, and "delete" deactivates (orders and the audit trail keep a user to point at).
 */
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

export interface ScimRequest {
  method: string;
  /** Path below the SCIM base, e.g. `/Users/123`. */
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  authorization?: string | null;
  /** Absolute base URL for `meta.location`. */
  baseUrl: string;
}
export interface ScimResponse {
  status: number;
  body?: unknown;
}

class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly scimType: string | null,
    detail: string,
  ) {
    super(detail);
  }
}

const err = (e: ScimError): ScimResponse => ({
  status: e.status,
  body: {
    schemas: [ERROR],
    status: String(e.status),
    ...(e.scimType ? { scimType: e.scimType } : {}),
    detail: e.message,
  },
});

export async function createScimToken(
  db: PrimaryDb,
  name: string,
  actor: { id: string | null; label: string },
): Promise<{ id: string; token: string }> {
  const token = `scim_${newToken()}`;
  const [row] = await db
    .insert(schema.scimTokens)
    .values({ name: name.slice(0, 80), tokenHash: hashToken(token) })
    .returning({ id: schema.scimTokens.id });
  await recordAudit(db, {
    actorId: actor.id,
    actorLabel: actor.label,
    action: 'scim.token.created',
    targetType: 'scim_token',
    targetId: row!.id,
  });
  return { id: row!.id, token };
}

export async function revokeScimToken(
  db: PrimaryDb,
  id: string,
  actor: { id: string | null; label: string },
): Promise<void> {
  await db
    .update(schema.scimTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.scimTokens.id, id));
  await recordAudit(db, {
    actorId: actor.id,
    actorLabel: actor.label,
    action: 'scim.token.revoked',
    targetType: 'scim_token',
    targetId: id,
  });
}

type UserRow = typeof schema.users.$inferSelect;

const toUser = (u: UserRow, base: string) => ({
  schemas: [USER],
  id: u.id,
  ...(u.externalId ? { externalId: u.externalId } : {}),
  userName: u.email,
  name: { formatted: u.name },
  displayName: u.name,
  emails: [{ value: u.email, primary: true, type: 'work' }],
  active: u.status === 'active',
  meta: {
    resourceType: 'User',
    created: u.createdAt.toISOString(),
    lastModified: u.updatedAt.toISOString(),
    location: `${base}/Users/${u.id}`,
  },
});

/** Azure AD sends booleans as strings ("False"); Okta sends real booleans. Accept both. */
const asBool = (v: unknown): boolean | null =>
  typeof v === 'boolean'
    ? v
    : typeof v === 'string' && /^(true|false)$/i.test(v)
      ? v.toLowerCase() === 'true'
      : null;

interface UserInput {
  userName?: string;
  externalId?: string | null;
  displayName?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  emails?: { value: string; primary?: boolean }[];
  active?: unknown;
}

const nameOf = (i: UserInput): string | undefined =>
  i.displayName ??
  i.name?.formatted ??
  ([i.name?.givenName, i.name?.familyName].filter(Boolean).join(' ') || undefined);

function emailOf(i: UserInput): string {
  const raw = i.userName ?? i.emails?.find((e) => e.primary)?.value ?? i.emails?.[0]?.value;
  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success)
    throw new ScimError(400, 'invalidValue', 'userName must be an email address');
  return parsed.data;
}

export interface ScimOptions {
  /** Roles an identity provider may assign through SCIM Groups. `owner` is never allowed, whatever is listed here. */
  managedRoles?: string[];
  maxPageSize?: number;
}

export class ScimService {
  constructor(private readonly opts: ScimOptions = {}) {}

  private get maxPage() {
    return this.opts.maxPageSize ?? 100;
  }

  async handle(db: PrimaryDb, req: ScimRequest): Promise<ScimResponse> {
    try {
      const actor = await this.authenticate(db, req.authorization);
      return await this.route(db, req, actor);
    } catch (e) {
      if (e instanceof ScimError) return err(e);
      throw e;
    }
  }

  private async authenticate(
    db: PrimaryDb,
    header: string | null | undefined,
  ): Promise<{ id: string | null; label: string }> {
    const m = /^Bearer (scim_[A-Za-z0-9_-]{20,100})$/.exec(header ?? '');
    if (!m) throw new ScimError(401, null, 'Missing or malformed bearer token');
    const [t] = await db
      .select()
      .from(schema.scimTokens)
      .where(eq(schema.scimTokens.tokenHash, hashToken(m[1] as string)));
    if (!t || t.revokedAt) throw new ScimError(401, null, 'Invalid token');
    await db
      .update(schema.scimTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.scimTokens.id, t.id));
    return { id: null, label: `scim:${t.name}` };
  }

  private async route(
    db: PrimaryDb,
    req: ScimRequest,
    actor: { id: string | null; label: string },
  ): Promise<ScimResponse> {
    const parts = req.path.replace(/\/+$/, '').split('/').filter(Boolean);
    const [resource, id] = parts;
    const m = req.method.toUpperCase();
    if (parts.length > 2) throw new ScimError(404, null, 'Not found');

    if (resource === 'ServiceProviderConfig' && m === 'GET')
      return { status: 200, body: this.providerConfig() };
    if (resource === 'ResourceTypes' && m === 'GET')
      return { status: 200, body: this.resourceTypes(req.baseUrl) };
    if (resource === 'Schemas' && m === 'GET')
      return { status: 200, body: { schemas: [LIST], totalResults: 0, Resources: [] } };

    if (resource === 'Users') {
      if (!id) {
        if (m === 'GET') return this.listUsers(db, req);
        if (m === 'POST') return this.createUser(db, req, actor);
      } else {
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new ScimError(404, null, 'User not found');
        if (m === 'GET') return { status: 200, body: toUser(await this.user(db, id), req.baseUrl) };
        if (m === 'PUT') return this.replaceUser(db, req, id, actor);
        if (m === 'PATCH') return this.patchUser(db, req, id, actor);
        if (m === 'DELETE') return this.deactivate(db, id, actor);
      }
    }
    if (resource === 'Groups') {
      if (!id && m === 'GET') return this.listGroups(db, req);
      if (id && m === 'GET') return { status: 200, body: await this.group(db, id, req.baseUrl) };
      if (id && m === 'PATCH') return this.patchGroup(db, req, id, actor);
      if (m === 'POST' || m === 'PUT' || m === 'DELETE')
        throw new ScimError(
          403,
          null,
          'Roles are managed in Sold; SCIM may only change group membership',
        );
    }
    throw new ScimError(
      m === 'GET' || m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE' ? 404 : 405,
      null,
      'Not found',
    );
  }

  private async user(db: PrimaryDb, id: string): Promise<UserRow> {
    const [u] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, id), eq(schema.users.kind, 'staff')));
    if (!u) throw new ScimError(404, null, 'User not found');
    return u;
  }

  private providerConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: this.maxPage },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'Authentication with a SCIM bearer token',
        },
      ],
    };
  }

  private resourceTypes(base: string) {
    const rt = (name: string, endpoint: string, schemaId: string) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: name,
      name,
      endpoint,
      schema: schemaId,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${name}` },
    });
    return {
      schemas: [LIST],
      totalResults: 2,
      Resources: [rt('User', '/Users', USER), rt('Group', '/Groups', GROUP)],
    };
  }

  // ---- users ------------------------------------------------------------------------------------------------

  private parseFilter(
    filter: string | null,
  ): { column: 'email' | 'externalId' | 'id' | 'status'; value: string } | null {
    if (!filter) return null;
    const m =
      /^\s*(userName|externalId|id|active)\s+eq\s+(?:"([^"]{1,254})"|(true|false))\s*$/i.exec(
        filter,
      );
    if (!m)
      throw new ScimError(
        400,
        'invalidFilter',
        'Only `userName|externalId|id|active eq <value>` filters are supported',
      );
    const attr = (m[1] as string).toLowerCase();
    if (attr === 'username') return { column: 'email', value: (m[2] ?? '').toLowerCase() };
    if (attr === 'externalid') return { column: 'externalId', value: m[2] ?? '' };
    if (attr === 'id') return { column: 'id', value: m[2] ?? '' };
    return {
      column: 'status',
      value: (m[3] ?? m[2] ?? '').toLowerCase() === 'true' ? 'active' : 'disabled',
    };
  }

  private async listUsers(db: PrimaryDb, req: ScimRequest): Promise<ScimResponse> {
    const q = req.query ?? new URLSearchParams();
    const start = Math.max(1, Number(q.get('startIndex') ?? '1') || 1);
    const count = Math.min(
      this.maxPage,
      Math.max(0, Number(q.get('count') ?? String(this.maxPage)) || 0),
    );
    const f = this.parseFilter(q.get('filter'));
    const col =
      f &&
      {
        email: schema.users.email,
        externalId: schema.users.externalId,
        id: schema.users.id,
        status: schema.users.status,
      }[f.column];
    if (f?.column === 'id' && !/^[0-9a-f-]{36}$/.test(f.value))
      return {
        status: 200,
        body: {
          schemas: [LIST],
          totalResults: 0,
          startIndex: start,
          itemsPerPage: 0,
          Resources: [],
        },
      };
    const where = and(eq(schema.users.kind, 'staff'), col && f ? eq(col, f.value) : undefined);
    const total =
      (
        await db
          .select({ n: sql<string>`count(*)` })
          .from(schema.users)
          .where(where)
      )[0]?.n ?? '0';
    const rows =
      count === 0
        ? []
        : await db
            .select()
            .from(schema.users)
            .where(where)
            .orderBy(schema.users.createdAt, schema.users.id)
            .limit(count)
            .offset(start - 1);
    return {
      status: 200,
      body: {
        schemas: [LIST],
        totalResults: Number(total),
        startIndex: start,
        itemsPerPage: rows.length,
        Resources: rows.map((u) => toUser(u, req.baseUrl)),
      },
    };
  }

  private async createUser(
    db: PrimaryDb,
    req: ScimRequest,
    actor: { id: string | null; label: string },
  ): Promise<ScimResponse> {
    const input = (req.body ?? {}) as UserInput;
    const email = emailOf(input);
    const active = asBool(input.active) ?? true;
    const created = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.users)
        .values({
          email,
          name: (nameOf(input) ?? '').slice(0, 120),
          kind: 'staff',
          status: active ? 'active' : 'disabled',
          externalId: input.externalId ?? null,
        })
        .onConflictDoNothing()
        .returning();
      const u = inserted[0];
      if (!u)
        throw new ScimError(
          409,
          'uniqueness',
          'A user with that userName or externalId already exists',
        );
      await recordAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.label,
        action: 'user.provisioned',
        targetType: 'user',
        targetId: u.id,
        detail: { via: 'scim' },
      });
      return u;
    });
    return { status: 201, body: toUser(created, req.baseUrl) };
  }

  private async replaceUser(
    db: PrimaryDb,
    req: ScimRequest,
    id: string,
    actor: { id: string | null; label: string },
  ): Promise<ScimResponse> {
    await this.user(db, id);
    const input = (req.body ?? {}) as UserInput;
    const email = emailOf(input);
    const active = asBool(input.active) ?? true;
    const updated = await this.write(
      db,
      id,
      {
        email,
        name: (nameOf(input) ?? '').slice(0, 120),
        externalId: input.externalId ?? null,
        status: active ? 'active' : 'disabled',
      },
      actor,
    );
    return { status: 200, body: toUser(updated, req.baseUrl) };
  }

  private async patchUser(
    db: PrimaryDb,
    req: ScimRequest,
    id: string,
    actor: { id: string | null; label: string },
  ): Promise<ScimResponse> {
    const current = await this.user(db, id);
    const body = (req.body ?? {}) as {
      schemas?: string[];
      Operations?: { op: string; path?: string; value?: unknown }[];
    };
    if (!body.schemas?.includes(PATCH_OP) || !Array.isArray(body.Operations))
      throw new ScimError(400, 'invalidSyntax', 'Not a SCIM PatchOp');
    const next = {
      email: current.email,
      name: current.name,
      externalId: current.externalId,
      status: current.status as 'active' | 'disabled',
    };
    for (const op of body.Operations) {
      const kind = String(op.op).toLowerCase();
      if (kind !== 'add' && kind !== 'replace' && kind !== 'remove')
        throw new ScimError(400, 'invalidSyntax', `Unsupported op "${op.op}"`);
      // Okta-style: no path, the value is an object of attributes.
      const entries: [string, unknown][] = op.path
        ? [[op.path, op.value]]
        : Object.entries((op.value ?? {}) as Record<string, unknown>);
      for (const [path, value] of entries) {
        switch (path) {
          case 'active': {
            const b = asBool(value);
            if (b === null) throw new ScimError(400, 'invalidValue', 'active must be a boolean');
            next.status = b ? 'active' : 'disabled';
            break;
          }
          case 'userName':
            if (kind !== 'remove') next.email = emailOf({ userName: String(value) });
            break;
          case 'displayName':
          case 'name.formatted':
            next.name = kind === 'remove' ? '' : String(value ?? '').slice(0, 120);
            break;
          case 'externalId':
            next.externalId = kind === 'remove' ? null : String(value);
            break;
          case 'name': {
            const n = nameOf({ name: value as UserInput['name'] });
            if (n !== undefined) next.name = n.slice(0, 120);
            break;
          }
          default:
            if (/^emails/.test(path) && kind !== 'remove') {
              const v = Array.isArray(value)
                ? (value as { value?: string }[])[0]?.value
                : (value as { value?: string } | string | undefined);
              next.email = emailOf({ userName: typeof v === 'string' ? v : v?.value });
            }
          // Unknown attributes are ignored, as the RFC allows for unsupported ones.
        }
      }
    }
    const updated = await this.write(db, id, next, actor);
    return { status: 200, body: toUser(updated, req.baseUrl) };
  }

  private async write(
    db: PrimaryDb,
    id: string,
    v: { email: string; name: string; externalId: string | null; status: 'active' | 'disabled' },
    actor: { id: string | null; label: string },
  ): Promise<UserRow> {
    try {
      return await db.transaction(async (tx) => {
        const [u] = await tx
          .update(schema.users)
          .set({ email: v.email, name: v.name, externalId: v.externalId, status: v.status })
          .where(and(eq(schema.users.id, id), eq(schema.users.kind, 'staff')))
          .returning();
        if (!u) throw new ScimError(404, null, 'User not found');
        if (v.status === 'disabled')
          await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${id}`);
        await recordAudit(tx, {
          actorId: actor.id,
          actorLabel: actor.label,
          action: v.status === 'disabled' ? 'user.disabled' : 'user.updated',
          targetType: 'user',
          targetId: id,
          detail: { via: 'scim' },
        });
        return u;
      });
    } catch (e) {
      if ((e as { cause?: { code?: string } }).cause?.code === '23505')
        throw new ScimError(409, 'uniqueness', 'userName or externalId already in use');
      throw e;
    }
  }

  private async deactivate(
    db: PrimaryDb,
    id: string,
    actor: { id: string | null; label: string },
  ): Promise<ScimResponse> {
    const u = await this.user(db, id);
    await this.write(
      db,
      id,
      { email: u.email, name: u.name, externalId: u.externalId, status: 'disabled' },
      actor,
    );
    return { status: 204 };
  }

  // ---- groups = roles -----------------------------------------------------------------------------------------

  private managed(): string[] {
    return (
      this.opts.managedRoles ?? [
        'admin',
        'catalog-manager',
        'order-manager',
        'content-editor',
        'support',
      ]
    ).filter((r) => r !== 'owner');
  }

  private async group(db: PrimaryDb, id: string, base: string) {
    if (!this.managed().includes(id)) throw new ScimError(404, null, 'Group not found');
    const members = await db.execute<{ user_id: string; email: string }>(
      sql`SELECT ur.user_id, u.email FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_name = ${id} ORDER BY u.email`,
    );
    return {
      schemas: [GROUP],
      id,
      displayName: id,
      members: members.rows.map((m) => ({ value: m.user_id, display: m.email })),
      meta: { resourceType: 'Group', location: `${base}/Groups/${id}` },
    };
  }

  private async listGroups(db: PrimaryDb, req: ScimRequest): Promise<ScimResponse> {
    const names = this.managed();
    const resources = await Promise.all(names.map((n) => this.group(db, n, req.baseUrl)));
    return {
      status: 200,
      body: {
        schemas: [LIST],
        totalResults: resources.length,
        startIndex: 1,
        itemsPerPage: resources.length,
        Resources: resources,
      },
    };
  }

  private async patchGroup(
    db: PrimaryDb,
    req: ScimRequest,
    id: string,
    actor: { id: string | null; label: string },
  ): Promise<ScimResponse> {
    if (!this.managed().includes(id)) throw new ScimError(404, null, 'Group not found');
    const body = (req.body ?? {}) as {
      Operations?: { op: string; path?: string; value?: unknown }[];
    };
    if (!Array.isArray(body.Operations))
      throw new ScimError(400, 'invalidSyntax', 'Not a SCIM PatchOp');
    await db.transaction(async (tx) => {
      for (const op of body.Operations ?? []) {
        const kind = String(op.op).toLowerCase();
        if (kind === 'remove' && op.path) {
          const m = /^members\[value eq "([0-9a-f-]{36})"\]$/.exec(op.path);
          if (!m) throw new ScimError(400, 'invalidPath', 'Unsupported path');
          await tx.execute(
            sql`DELETE FROM user_roles WHERE user_id = ${m[1]} AND role_name = ${id}`,
          );
        } else if (
          (kind === 'add' || kind === 'replace' || kind === 'remove') &&
          (op.path === 'members' || !op.path)
        ) {
          const raw = op.path ? op.value : (op.value as { members?: unknown } | undefined)?.members;
          const members = ((Array.isArray(raw) ? raw : []) as { value?: string }[])
            .map((m) => m.value ?? '')
            .filter((v) => /^[0-9a-f-]{36}$/.test(v));
          if (kind === 'replace')
            await tx.execute(
              sql`DELETE FROM user_roles WHERE role_name = ${id} AND granted_by LIKE 'scim:%'`,
            );
          for (const userId of members) {
            const [u] = await tx
              .select({ id: schema.users.id })
              .from(schema.users)
              .where(and(eq(schema.users.id, userId), eq(schema.users.kind, 'staff')));
            if (!u) throw new ScimError(400, 'invalidValue', `Unknown user ${userId}`);
            if (kind === 'remove')
              await tx.execute(
                sql`DELETE FROM user_roles WHERE user_id = ${userId} AND role_name = ${id}`,
              );
            else
              await tx
                .insert(schema.userRoles)
                .values({ userId, roleName: id, grantedBy: actor.label })
                .onConflictDoNothing();
          }
        } else throw new ScimError(400, 'invalidSyntax', 'Unsupported operation');
      }
      await recordAudit(tx, {
        actorId: actor.id,
        actorLabel: actor.label,
        action: 'role.membership.changed',
        targetType: 'role',
        targetId: id,
        detail: { via: 'scim' },
      });
    });
    // Permissions changed for everyone in the group: make them sign in again.
    await db.execute(
      sql`DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM user_roles WHERE role_name = ${id})`,
    );
    return { status: 200, body: await this.group(db, id, req.baseUrl) };
  }
}
