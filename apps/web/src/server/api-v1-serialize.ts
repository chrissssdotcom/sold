import type { CatalogProduct } from '@sold/commerce';

export function productJson(p: CatalogProduct) {
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    status: p.status,
    tags: p.tags,
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      options: v.options,
      prices: v.prices.map((x) => ({
        currency: x.currency,
        amount: x.amount.amount.toString(),
        compareAt: x.compareAt ? x.compareAt.amount.toString() : null,
      })),
    })),
  };
}
