import type { MetadataRoute } from 'next';
import { eq, schema } from '@sold/db';
import { markets } from '@sold/storefront/i18n';
import { getRuntime } from '../server/runtime';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = process.env['SOLD_PUBLIC_URL'] ?? 'http://localhost:3000';
  const { db } = getRuntime();
  const [products, pages] = await Promise.all([
    db.replica
      .select({ handle: schema.products.handle, updatedAt: schema.products.updatedAt })
      .from(schema.products)
      .where(eq(schema.products.status, 'active')),
    db.replica
      .select({
        path: schema.pages.path,
        locale: schema.pages.locale,
        updatedAt: schema.pages.updatedAt,
      })
      .from(schema.pages)
      .where(eq(schema.pages.status, 'published')),
  ]);
  const languages = (path: string) =>
    Object.fromEntries(markets.map((m) => [m.tag, `${site}/${m.slug}${path === '/' ? '' : path}`]));
  return [
    ...markets.map((m) => ({
      url: `${site}/${m.slug}/products`,
      changeFrequency: 'daily' as const,
      alternates: { languages: languages('/products') },
    })),
    ...products.flatMap((p) =>
      markets.map((m) => ({
        url: `${site}/${m.slug}/products/${p.handle}`,
        lastModified: p.updatedAt,
        changeFrequency: 'weekly' as const,
        alternates: { languages: languages(`/products/${p.handle}`) },
      })),
    ),
    ...pages.map((p) => ({
      url: `${site}/${p.locale}${p.path === '/' ? '' : p.path}`,
      lastModified: p.updatedAt,
      alternates: { languages: languages(p.path) },
    })),
  ];
}
