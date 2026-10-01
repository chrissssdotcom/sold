import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { marketFor } from '@sold/storefront/i18n';
import { storefrontData } from '../../../storefront/data';
import { theme } from '../../../storefront/theme';

export const revalidate = 60;
export const generateStaticParams = () => [];
export const metadata: Metadata = {
  title: 'Shop everything',
  description: 'Every piece, made in small batches.',
};

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const products = await storefrontData.products(48);
  const stock = await storefrontData.availability(
    products.flatMap((p) => p.variants.map((v) => v.id)),
  );
  const { ProductListPage } = theme.components;
  return <ProductListPage market={market} products={products} stock={stock} theme={theme} />;
}
