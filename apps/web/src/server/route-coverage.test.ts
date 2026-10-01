import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const api = join(__dirname, '..', 'app', 'api');

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routes(p);
    return name === 'route.ts' ? [p] : [];
  });
}

/** Admin routes that are deliberately not behind `adminRoute` (they establish or end a session). Adding here needs a reason. */
const ADMIN_PUBLIC = new Set([
  'admin/auth/login/route.ts', // password login (rate limited)
  'admin/auth/logout/route.ts',
  'admin/auth/me/route.ts', // answers 401 itself when anonymous
  'admin/auth/sso/route.ts',
  'admin/auth/oidc/start/route.ts',
  'admin/auth/oidc/callback/route.ts',
  'admin/auth/saml/metadata/route.ts',
  'admin/auth/saml/start/route.ts',
  'admin/auth/saml/acs/route.ts',
]);

describe('route authorisation coverage (fails closed for new routes)', () => {
  const all = routes(api).map((p) => ({ rel: relative(api, p), src: readFileSync(p, 'utf8') }));

  it('finds the routes it is meant to police', () => {
    expect(all.filter((r) => r.rel.startsWith('admin/')).length).toBeGreaterThan(30);
  });

  it('every /api/admin route is wrapped in adminRoute, unless it is a listed session entry point', () => {
    const offenders = all
      .filter((r) => r.rel.startsWith('admin/') && !ADMIN_PUBLIC.has(r.rel))
      .filter((r) => !/\badminRoute\(/.test(r.src))
      .map((r) => r.rel);
    expect(offenders).toEqual([]);
  });

  it('every adminRoute names a permission (null only where any signed-in staff may call it)', () => {
    const nullOk = new Set<string>(['admin/dashboard/route.ts']);
    const offenders = all
      .filter((r) => r.rel.startsWith('admin/') && /adminRoute\(\s*null/.test(r.src))
      .filter((r) => !nullOk.has(r.rel))
      .map((r) => r.rel);
    expect(offenders).toEqual([]);
  });

  it('every /api/v1 route (except the public spec) goes through apiRoute with a scope', () => {
    const offenders = all
      .filter((r) => r.rel.startsWith('v1/') && r.rel !== 'v1/openapi.json/route.ts')
      .filter((r) => !/\bapiRoute\(\s*'[a-z]+:[a-z]+'/.test(r.src))
      .map((r) => r.rel);
    expect(offenders).toEqual([]);
  });

  it('no admin route exports a bare handler that bypasses the wrapper', () => {
    const offenders = all
      .filter((r) => r.rel.startsWith('admin/') && !ADMIN_PUBLIC.has(r.rel))
      .filter((r) => /export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(r.src))
      .map((r) => r.rel);
    expect(offenders).toEqual([]);
  });
});
