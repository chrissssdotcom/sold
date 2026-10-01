import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { marketFor } from '@sold/storefront/i18n';
import { theme } from '../../../storefront/theme';

export const metadata: Metadata = { title: 'Your bag', robots: { index: false } };

export default async function Cart({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const { CartPage } = theme.components;
  return <CartPage market={market} />;
}
