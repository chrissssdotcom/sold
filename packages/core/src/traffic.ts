/**
 * Traffic priority classes (Section 8A.6). Under saturation the lowest classes are shed first with
 * `503` + `Retry-After`. Lower number = higher priority.
 */
export const routeClasses = [
  'checkout',
  'cart',
  'browse',
  'account',
  'admin',
  'reporting',
  'internal',
] as const;
export type RouteClass = (typeof routeClasses)[number];

export const routePriority: Record<RouteClass, number> = {
  checkout: 0,
  cart: 1,
  browse: 2,
  account: 3,
  admin: 4,
  reporting: 5,
  // Health, metrics, version: never shed (probes must keep answering) and never counted as user traffic.
  internal: -1,
};

const rules: [RegExp, RouteClass][] = [
  [/^\/(?:api\/)?(?:checkout|payments?|webhooks\/payments?)(?:\/|$)/, 'checkout'],
  [/^\/(?:api\/)?cart(?:\/|$)/, 'cart'],
  [/^\/(?:api\/)?(?:account|login|logout|register|auth)(?:\/|$)/, 'account'],
  [/^\/(?:api\/)?admin(?:\/|$)/, 'admin'],
  [/^\/(?:api\/)?(?:reporting|reports|scim)(?:\/|$)/, 'reporting'],
  [/^\/(?:api\/health|api\/version|metrics)(?:\/|$)/, 'internal'],
];

/** Locale prefix (`/en-au/...`) is ignored when classifying. */
export function routeClassOf(pathname: string): RouteClass {
  const path = pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/i, '');
  for (const [re, cls] of rules) if (re.test(path)) return cls;
  return 'browse';
}

/** Whether a request of `cls` should be shed when the platform is shedding everything below `shedBelow`. */
export function shouldShed(cls: RouteClass, shedBelow: RouteClass | null): boolean {
  if (shedBelow === null || cls === 'internal') return false;
  return routePriority[cls] >= routePriority[shedBelow];
}

/** Classes an operator can shed, lowest priority first. Checkout is deliberately absent: it is never shed (Section 8A.6). */
export const sheddableClasses = ['reporting', 'admin', 'account', 'browse', 'cart'] as const;
export type SheddableClass = (typeof sheddableClasses)[number];

export const shedFlagKey = (cls: SheddableClass): string => `shed.${cls}`;

/** `shed.<class>` flags that are on -> the highest-priority class being shed (it and everything below go). */
export function shedBelowFrom(on: ReadonlySet<string>): RouteClass | null {
  let best: SheddableClass | null = null;
  for (const cls of sheddableClasses)
    if (on.has(shedFlagKey(cls)) && (best === null || routePriority[cls] < routePriority[best]))
      best = cls;
  return best;
}

/** Hard override that needs no database: `SOLD_SHED_BELOW=browse`. Anything unrecognised (or `checkout`) is ignored. */
export function shedBelowFromEnv(raw: string | undefined): RouteClass | null {
  return (sheddableClasses as readonly string[]).includes(raw ?? '') ? (raw as RouteClass) : null;
}

/** The more protective (higher-priority-class shed) of two decisions. */
export function strictestShed(a: RouteClass | null, b: RouteClass | null): RouteClass | null {
  if (a === null) return b;
  if (b === null) return a;
  return routePriority[a] <= routePriority[b] ? a : b;
}
