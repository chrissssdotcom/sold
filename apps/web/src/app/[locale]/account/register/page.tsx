import { notFound, redirect } from 'next/navigation';
import { marketFor } from '@sold/storefront/i18n';
import { currentCustomer } from '../../../../server/customer';
import { theme } from '../../../../storefront/theme';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Create account', robots: { index: false } };

export default async function Register({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  if (await currentCustomer()) redirect(`/${market.slug}/account`);
  const { AuthPage } = theme.components;
  return <AuthPage market={market} mode="register" />;
}
