import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PageRenderer } from '../../../storefront/blocks/render';
import { getPublishedPage } from '../../../storefront/lib/data';
import { marketFor } from '../../../storefront/lib/i18n';

export const revalidate = 60;
// Render on first request, then serve from the shared ISR cache (nothing is prerendered at build: no database needed).
export const generateStaticParams = () => [];

const pathOf = (slug: string[]) => `/${slug.join('/')}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string[] }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const page = await getPublishedPage(locale, pathOf(slug));
  if (!page) return {};
  const { seo, title } = page.page;
  return {
    title: seo.title ?? title,
    description: seo.description,
    robots: seo.noindex ? { index: false } : undefined,
    openGraph: seo.ogImage ? { images: [seo.ogImage] } : undefined,
  };
}

export default async function BuilderPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string[] }>;
}) {
  const { locale, slug } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const page = await getPublishedPage(locale, pathOf(slug));
  if (!page) notFound();
  return <PageRenderer tree={page.tree} market={market} />;
}
