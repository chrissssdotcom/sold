import {
  AuthService,
  RoleService,
  ScimService,
  SessionService,
  type ResolvedSession,
  type UserKind,
} from '@sold/identity';
import * as generated from '../../.generated/extensions';
import { getRuntime } from './runtime';

interface Services {
  sessions: SessionService;
  auth: AuthService;
  roles: RoleService;
  scim: ScimService;
}
const holder = globalThis as unknown as { __soldIdentity?: Services };

/** Permission keys contributed by installed extensions, so roles can grant them. Read from the generated registry, not the live kernel. */
function extensionPermissions(): string[] {
  const candidates = (
    generated as unknown as {
      candidates: { manifest: { permissions: readonly { key: string }[] } }[];
    }
  ).candidates;
  return candidates.flatMap((c) => c.manifest.permissions.map((p) => p.key));
}

export function getIdentity(): Services {
  if (!holder.__soldIdentity) {
    const sessions = new SessionService();
    holder.__soldIdentity = {
      sessions,
      auth: new AuthService(sessions),
      roles: new RoleService(extensionPermissions),
      scim: new ScimService(),
    };
  }
  return holder.__soldIdentity;
}

/** `__Host-` cookies need https; plain http local development uses unprefixed names. */
export function sessionCookieName(kind: UserKind): string {
  const base = kind === 'staff' ? 'sold_admin' : 'sold_session';
  return getRuntime().env.SOLD_ENVIRONMENT === 'local' ? base : `__Host-${base}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(kind: UserKind, token: string, expires: Date): string {
  const secure = getRuntime().env.SOLD_ENVIRONMENT !== 'local';
  // HttpOnly: script cannot read it. SameSite=Lax (staff: Strict): cross-site requests do not carry it.
  return `${sessionCookieName(kind)}=${token}; Path=/; HttpOnly; SameSite=${kind === 'staff' ? 'Strict' : 'Lax'}; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(kind: UserKind): string {
  const secure = getRuntime().env.SOLD_ENVIRONMENT !== 'local';
  return `${sessionCookieName(kind)}=; Path=/; HttpOnly; SameSite=${kind === 'staff' ? 'Strict' : 'Lax'}; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function sessionToken(cookieHeader: string | null, kind: UserKind): string | null {
  return readCookie(cookieHeader, sessionCookieName(kind));
}

/** Resolve the signed-in user for a request (one indexed query), or null. */
export async function currentSession(
  cookieHeader: string | null,
  kind: UserKind,
): Promise<ResolvedSession | null> {
  const token = sessionToken(cookieHeader, kind);
  return getIdentity().sessions.resolve(getRuntime().db.primary, token);
}

/** The client address, only when the operator says a trusted proxy sets it. Otherwise unknown (throttling then keys on the account alone). */
export function clientIp(request: Request): string | null {
  if (!getRuntime().env.SOLD_TRUST_PROXY) return null;
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim().slice(0, 45);
  const xff = request.headers.get('x-forwarded-for');
  return xff ? (xff.split(',')[0]?.trim().slice(0, 45) ?? null) : null;
}
