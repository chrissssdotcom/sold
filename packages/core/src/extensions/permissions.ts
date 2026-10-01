import type { ExtensionManifest } from '@sold/extension-sdk';

/** Permissions Base itself defines. Extension permissions are namespaced by extension name. */
export const basePermissions = [
  'base.catalog.read',
  'base.catalog.write',
  'base.orders.read',
  'base.orders.write',
  'base.customers.read',
  'base.customers.write',
  'base.pages.write',
  'base.settings.write',
  'base.extensions.manage',
  'base.reports.read',
  'base.audit.read',
] as const;

export type BasePermission = (typeof basePermissions)[number];

export interface PermissionEntry {
  key: string;
  description: string;
  /** `base` or the owning extension. */
  owner: string;
}

export class PermissionRegistry {
  private readonly entries = new Map<string, PermissionEntry>();

  constructor() {
    for (const key of basePermissions)
      this.entries.set(key, { key, description: key.replaceAll('.', ' '), owner: 'base' });
  }

  register(manifest: ExtensionManifest): void {
    for (const p of manifest.permissions)
      this.entries.set(p.key, { key: p.key, description: p.description, owner: manifest.name });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** For the admin role editor. */
  list(): PermissionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  }
}

export interface AuthorizationSubject {
  id: string;
  kind: 'admin' | 'customer' | 'api-key' | 'system';
  /** Permissions resolved by the caller from the live session. An authorizer reads these; it never trusts a client. */
  permissions?: readonly string[];
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(public readonly permission: string) {
    super(`Forbidden: missing permission "${permission}"`);
    this.name = 'ForbiddenError';
  }
}

/**
 * The single primitive every route and action goes through (Section 5.6). No ad-hoc permission checks
 * anywhere else. The RBAC implementation arrives in Phase 5; until then the default denies everything,
 * so an unauthenticated deploy fails closed.
 */
export interface Authorizer {
  authorize(
    subject: AuthorizationSubject | null,
    permission: string,
    resource?: { type: string; id: string },
  ): Promise<void>;
}

export const denyAll: Authorizer = {
  async authorize(_subject, permission) {
    throw new ForbiddenError(permission);
  },
};
