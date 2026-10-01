import { notFound, redirect } from 'next/navigation';
import { marketFor } from '@sold/storefront/i18n';
import { getCommerce } from '../../../server/commerce';
import { ExtensionSlot } from '../../../server/extension-ui';
import { currentCustomer } from '../../../server/customer';
import { getRuntime } from '../../../server/runtime';
import { theme } from '../../../storefront/theme';

// Per-customer and private: never cached by the ISR layer or a CDN.
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Your account', robots: { index: false } };

export default async function Account({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const customer = await currentCustomer();
  if (!customer) redirect(`/${market.slug}/account/login`);
  const { orders } = await getCommerce();
  const list = await orders.listForCustomer(getRuntime().db.primary, customer.id, { limit: 20 });
  const { AccountPage } = theme.components;
  return (
    <AccountPage
      market={market}
      slots={{
        dashboard: <ExtensionSlot name="account.dashboard" props={{ customerId: customer.id }} />,
      }}
      customer={{ name: customer.name, email: customer.email }}
      orders={list.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        placedAt: o.placedAt.toISOString(),
        total: o.total.toJSON(),
      }))}
    />
  );
}
