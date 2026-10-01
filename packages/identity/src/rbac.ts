import { z } from 'zod';

/**
 * Permissions are `<area>:<action>`. `*` grants everything, `area:*` grants every action in an area. A single function
 * decides: `can()`. Routes and services ask it; nothing else interprets permission strings.
 */
export const permissionPattern = /^(\*|[a-z][a-z0-9-]*:(\*|[a-z][a-z0-9-]*))$/;
/** Extension permissions are `<extension>.<group>.<action>` (the SDK requires the extension-name prefix). Exact grants only: no wildcards. */
export const extensionPermissionPattern = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
export const permissionSchema = z
  .string()
  .max(100)
  .refine((p) => permissionPattern.test(p) || extensionPermissionPattern.test(p), {
    message: 'permission like "orders:read", "orders:*" or an extension key like "loyalty-points.accounts.read"',
  });

export function can(granted: readonly string[], needed: string): boolean {
  if (extensionPermissionPattern.test(needed)) return granted.includes('*') || granted.includes(needed);
  if (!permissionPattern.test(needed) || needed === '*' || needed.endsWith(':*')) return false; // a check is always for a specific permission
  if (granted.includes('*') || granted.includes(needed)) return true;
  const area = needed.slice(0, needed.indexOf(':'));
  return granted.includes(`${area}:*`);
}

/** Areas and actions Base defines. Custom roles may only grant what exists here (plus extension-registered permissions). */
export const basePermissions: Record<string, readonly string[]> = {
  catalog: ['read', 'write', 'publish'],
  orders: ['read', 'write', 'cancel', 'fulfil'],
  payments: ['read', 'refund'],
  content: ['read', 'write', 'publish'],
  promotions: ['read', 'write'],
  theme: ['read', 'write'],
  customers: ['read', 'write'],
  reports: ['read'],
  settings: ['read', 'write'],
  extensions: ['read', 'write'],
  users: ['read', 'write', 'roles'],
  audit: ['read'],
};

export function isKnownPermission(p: string, extra: readonly string[] = []): boolean {
  if (p === '*') return true;
  if (extra.includes(p)) return true;
  // A dotted key is an extension permission and is only valid when an installed extension registered it.
  if (extensionPermissionPattern.test(p)) return false;
  const [area, action] = p.split(':') as [string, string];
  const actions = basePermissions[area];
  if (!actions) return extra.some((e) => e.startsWith(`${area}:`)) && action === '*';
  return action === '*' || actions.includes(action);
}
