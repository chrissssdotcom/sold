import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CartPage } from '../../../storefront/components/cart-page';
import { marketFor } from '../../../storefront/lib/i18n';

export const metadata: Metadata = { title: 'Your bag', robots: { index: false } };

export default async function Cart({ params }: { params: Promise<{ locale: string }> }) {
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
            <li aria-current="page">Bag</li>
          </ol>
        </nav>
        <h1>Your bag</h1>
      </header>
      <CartPage tag={market.tag} base={`/${market.slug}`} />
    </div>
  );
}
