import Link from 'next/link';
import { CartButton } from './cart-drawer';
import { MarketSwitcher } from './market-switcher';
import type { Market } from '../lib/i18n';

export function Announcement({ children }: { children: React.ReactNode }) {
  return (
    <div className="announce" role="region" aria-label="Store announcement">
      <p>{children}</p>
    </div>
  );
}

export function SiteHeader({ market, name }: { market: Market; name: string }) {
  const base = `/${market.slug}`;
  return (
    <header className="site-header">
      <div className="container site-header__row">
        <Link href={base} className="wordmark" aria-label={`${name} home`}>
          <span className="wordmark__mark" aria-hidden="true" />
          {name}
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href={`${base}/products`}>Shop</Link>
          <Link href={`${base}/products#new`}>New in</Link>
          <Link href={`${base}/journal`}>Journal</Link>
          <Link href={`${base}/about`}>About</Link>
        </nav>
        <div className="site-header__actions">
          <MarketSwitcher current={market.slug} />
          <CartButton label="Open bag" />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ market, name }: { market: Market; name: string }) {
  const base = `/${market.slug}`;
  return (
    <footer className="site-footer">
      <div className="container footer__grid">
        <div className="footer__brand">
          <span className="wordmark wordmark--light">
            <span className="wordmark__mark" aria-hidden="true" />
            {name}
          </span>
          <p>Considered objects for everyday rituals. Made in small batches, shipped with care.</p>
        </div>
        <nav aria-label="Shop">
          <h2 className="footer__h">Shop</h2>
          <ul>
            <li>
              <Link href={`${base}/products`}>All products</Link>
            </li>
            <li>
              <Link href={`${base}/products#new`}>New arrivals</Link>
            </li>
            <li>
              <Link href={`${base}/cart`}>Your bag</Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Company">
          <h2 className="footer__h">Company</h2>
          <ul>
            <li>
              <Link href={`${base}/about`}>Our story</Link>
            </li>
            <li>
              <Link href={`${base}/journal`}>Journal</Link>
            </li>
          </ul>
        </nav>
        <nav aria-label="Help">
          <h2 className="footer__h">Help</h2>
          <ul>
            <li>
              <Link href={`${base}/shipping`}>Shipping &amp; returns</Link>
            </li>
            <li>
              <Link href={`${base}/privacy`}>Privacy</Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="container footer__base">
        <small>
          © {new Date().getFullYear()} {name}. Prices in {market.currency}.
        </small>
        <small>Built on Sold</small>
      </div>
    </footer>
  );
}
