import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { marketFor } from '@sold/storefront/i18n';
import { verifyOrderToken } from '../../../../server/cart-token';
import { cartKey, getCommerce } from '../../../../server/commerce';
import { getRuntime } from '../../../../server/runtime';
import { theme } from '../../../../storefront/theme';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Order confirmed',
  robots: { index: false, follow: false },
};

export default async function OrderRoute({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const id = verifyOrderToken(cartKey(), token);
  if (!id) notFound();
  const { orders } = await getCommerce();
  const order = await orders.get(getRuntime().db.primary, id).catch(() => null);
  if (!order) notFound();
  const { OrderPage } = theme.components;
  return <OrderPage market={market} order={order} token={token} />;
}
