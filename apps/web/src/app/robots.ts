import type { MetadataRoute } from 'next';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const site = process.env['SOLD_PUBLIC_URL'] ?? 'http://localhost:3000';
  // Non-production environments are never indexed (mirrors the X-Robots-Tag header set in proxy.ts).
  if (process.env['SOLD_ENVIRONMENT'] !== 'prod')
    return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/x/', '/admin/', '/*/cart', '/*/checkout', '/*/order/'],
    },
    sitemap: `${site}/sitemap.xml`,
  };
}
