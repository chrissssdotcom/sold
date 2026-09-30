/**
 * Storefront locales. A locale slug is the URL prefix (`/en-au/...`); it decides language, number formatting and the
 * presentment currency. Adding a market is: add a row here, enable the currency in sold.config.ts, refresh FX.
 */
export interface Market {
  slug: string;
  /** BCP-47 tag for Intl. */
  tag: string;
  label: string;
  currency: string;
  /** Flag-free short code shown in the switcher. */
  short: string;
}

export const markets: readonly Market[] = [
  { slug: 'en-au', tag: 'en-AU', label: 'Australia', currency: 'AUD', short: 'AU' },
  { slug: 'en-us', tag: 'en-US', label: 'United States', currency: 'USD', short: 'US' },
] as const;

export const defaultMarket = markets[0] as Market;
export const localeSlugs = markets.map((m) => m.slug);

export function marketFor(slug: string): Market | undefined {
  return markets.find((m) => m.slug === slug);
}

/** Best market for an Accept-Language header (exact region, then language, then the default). */
export function negotiateMarket(header: string | null): Market {
  if (!header) return defaultMarket;
  const wanted = header
    .split(',')
    .map((part) => part.trim().split(';')[0]?.toLowerCase() ?? '')
    .filter(Boolean);
  for (const w of wanted) {
    const exact = markets.find((m) => m.slug === w);
    if (exact) return exact;
  }
  return defaultMarket;
}

/** Paths that are not storefront pages: never locale-prefixed. */
export const reservedPrefixes = ['api', 'x', 'admin', 'metrics', 'art', '_next', 'fonts'];
