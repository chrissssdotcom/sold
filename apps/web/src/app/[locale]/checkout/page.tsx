import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { marketFor } from '@sold/storefront/i18n';
import { theme } from '../../../storefront/theme';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

export default async function Checkout({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const { CheckoutPage } = theme.components;
  return <CheckoutPage market={market} />;
}
