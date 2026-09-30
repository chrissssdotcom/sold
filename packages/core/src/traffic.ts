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
