import Link from 'next/link';
import type { MarketProps } from '../../contract';
import { CartPage as CartView } from '../components/cart-page';

export function CartPage({ market }: MarketProps) {
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
      <CartView tag={market.tag} base={`/${market.slug}`} />
    </div>
  );
}
