import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckoutForm } from '../../../storefront/components/checkout-form';
import { marketFor } from '../../../storefront/lib/i18n';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

export default async function Checkout({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  return (
    <div className="container">
      <header className="page-head">
        <nav aria-label="Breadcrumb">
          <ol className="crumbs">
            <li>
              <Link href={`/${market.slug}`}>Home</Link>
            </li>
            <li>
              <Link href={`/${market.slug}/cart`}>Bag</Link>
            </li>
            <li aria-current="page">Checkout</li>
          </ol>
        </nav>
        <h1>Checkout</h1>
      </header>
      <CheckoutForm tag={market.tag} base={`/${market.slug}`} currency={market.currency} />
    </div>
  );
}
