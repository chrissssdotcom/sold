import type { CatalogProduct, CatalogVariant } from '@sold/commerce';
import type { MoneyJson } from './money';

export interface ProductView {
  handle: string;
  title: string;
  subtitle: string;
  badge: string | null;
  images: string[];
  description: string;
  highlights: string[];
  collection: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function viewOf(p: CatalogProduct): ProductView {
  const a = p.attributes;
  return {
    handle: p.handle,
    title: p.title,
    subtitle: str(a.subtitle) ?? '',
    badge: str(a.badge),
    images: strs(a.images),
    description: p.description,
    highlights: strs(a.highlights),
    collection: str(a.collection),
  };
}

export function priceIn(
  v: CatalogVariant,
  currency: string,
): { price: MoneyJson; compareAt: MoneyJson | null } | null {
  const p = v.prices.find((x) => x.currency === currency);
  return p
    ? { price: p.amount.toJSON(), compareAt: p.compareAt ? p.compareAt.toJSON() : null }
    : null;
}

/** Lowest variant price in a currency, for "From $x" on cards. */
export function fromPrice(
  p: CatalogProduct,
  currency: string,
): { price: MoneyJson; compareAt: MoneyJson | null; varies: boolean } | null {
  const priced = p.variants
    .map((v) => priceIn(v, currency))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (priced.length === 0) return null;
  const min = priced.reduce((a, b) => (BigInt(b.price.amount) < BigInt(a.price.amount) ? b : a));
  return { ...min, varies: new Set(priced.map((x) => x.price.amount)).size > 1 };
}
