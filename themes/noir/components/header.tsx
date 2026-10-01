import Link from 'next/link';
import type { ChromeProps } from '@sold/storefront';
import { CartButton, MarketSwitcher } from '@sold/storefront/default-theme';

/** Centred wordmark with navigation either side, a hairline of gold underneath. */
export function Header({ market, site }: ChromeProps) {
  const base = `/${market.slug}`;
  return (
    <header className="noir-header">
      <div className="container noir-header__row">
        <nav aria-label="Primary" className="noir-nav">
          <Link href={`${base}/products`}>Shop</Link>
          <Link href={`${base}/journal`}>Journal</Link>
          <Link href={`${base}/about`}>About</Link>
        </nav>
        <Link href={base} className="noir-logo" aria-label={`${site.name} home`}>
          {site.name}
        </Link>
        <div className="noir-actions">
          <MarketSwitcher current={market.slug} />
          <CartButton label="Open bag" />
        </div>
      </div>
    </header>
  );
}
