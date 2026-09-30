import type { ExtensionManifest, RouteDefinition } from '@sold/extension-sdk';

export type ExtensionRouteKind = RouteDefinition['kind'];

export interface MountedRoute {
  extension: string;
  route: RouteDefinition<never>;
  /** Full path, e.g. `/x/loyalty/points/:customerId`. */
  fullPath: string;
  pattern: RegExp;
  paramNames: string[];
}

export type RouteMatch =
  | { status: 'found'; mounted: MountedRoute; params: Record<string, string> }
  | { status: 'method-not-allowed'; allowed: string[] }
  | { status: 'not-found' };

/** `/x/<ext>` for storefront/api/webhook routes; `/admin/x/<ext>` for admin routes. */
export function mountPrefix(extension: string, kind: ExtensionRouteKind): string {
  return kind === 'admin' ? `/admin/x/${extension}` : `/x/${extension}`;
}

function compile(fullPath: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = fullPath
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), paramNames };
}

/** Routes contributed by extensions, mounted under a reserved prefix so they can never shadow Base routes. */
export class RouteTable {
  private readonly routes: MountedRoute[] = [];

  add(manifest: ExtensionManifest): void {
    for (const route of manifest.routes) {
      const base = mountPrefix(manifest.name, route.kind);
      const fullPath = route.path === '/' ? base : `${base}${route.path.replace(/\/$/, '')}`;
      this.routes.push({ extension: manifest.name, route, fullPath, ...compile(fullPath) });
    }
  }

  list(): readonly MountedRoute[] {
    return this.routes;
  }

  match(method: string, pathname: string): RouteMatch {
    // Reject anything that could escape the mount: encoded separators and dot segments never match.
    if (/%2f|%5c|\.\./i.test(pathname)) return { status: 'not-found' };
    const allowed = new Set<string>();
    for (const mounted of this.routes) {
      const m = mounted.pattern.exec(pathname);
      if (!m) continue;
      if (mounted.route.method !== method.toUpperCase()) {
        allowed.add(mounted.route.method);
        continue;
      }
      const params: Record<string, string> = {};
      for (const [i, name] of mounted.paramNames.entries()) {
        try {
          params[name] = decodeURIComponent(m[i + 1] as string);
        } catch {
          return { status: 'not-found' };
        }
      }
      return { status: 'found', mounted, params };
    }
    return allowed.size > 0
      ? { status: 'method-not-allowed', allowed: [...allowed].sort() }
      : { status: 'not-found' };
  }
}
