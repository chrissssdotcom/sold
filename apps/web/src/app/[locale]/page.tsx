import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageRenderer } from '@sold/storefront/blocks';
import { marketFor } from '@sold/storefront/i18n';
import { getPublishedPage, storefrontData } from '../../storefront/data';
import { blockRegistry, theme } from '../../storefront/theme';

// Served from the shared ISR cache and refreshed every minute; publishing a page purges it immediately.
export const revalidate = 60;
// Render on first request, then serve from the shared ISR cache (nothing is prerendered at build: no database needed).
export const generateStaticParams = () => [];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const page = await getPublishedPage(locale, '/');
  return page
    ? { title: page.page.seo.title ?? undefined, description: page.page.seo.description }
    : {};
}

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const page = await getPublishedPage(locale, '/');
  if (!page) {
    const { HomeFallback } = theme.components;
    return <HomeFallback market={market} />;
  }
  return (
    <PageRenderer
      tree={page.tree}
      registry={blockRegistry()}
      ctx={{ market, data: storefrontData, theme }}
    />
  );
}
