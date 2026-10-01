import { z } from 'zod';

/**
 * Permissions are `<area>:<action>`. `*` grants everything, `area:*` grants every action in an area. A single function
 * decides: `can()`. Routes and services ask it; nothing else interprets permission strings.
 */
export const permissionPattern = /^(\*|[a-z][a-z0-9-]*:(\*|[a-z][a-z0-9-]*))$/;
export const permissionSchema = z
  .string()
  .regex(permissionPattern, 'permission like "orders:read" or "orders:*"');

export function can(granted: readonly string[], needed: string): boolean {
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
  const [area, action] = p.split(':') as [string, string];
  if (extra.includes(p)) return true;
  const actions = basePermissions[area];
  if (!actions) return extra.some((e) => e.startsWith(`${area}:`)) && action === '*';
  return action === '*' || actions.includes(action);
}
