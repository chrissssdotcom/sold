import Link from 'next/link';
import type { MarketProps } from '../../contract';
import { CheckoutForm } from '../components/checkout-form';

export function CheckoutPage({ market }: MarketProps) {
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
