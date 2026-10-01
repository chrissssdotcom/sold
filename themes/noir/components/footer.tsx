import Link from 'next/link';
import type { ChromeProps } from '@sold/storefront';

/** A quiet one-row footer. */
export function Footer({ market, site }: ChromeProps) {
  return (
    <footer
      className="site-footer"
      style={{ background: '#0a0908', borderTop: '1px solid var(--line)' }}
    >
      <div className="container footer__base" style={{ marginTop: 0, borderTop: 0 }}>
        <small>
          © {new Date().getFullYear()} {site.name}. Prices in {market.currency}.
        </small>
        <small>
          <Link href={`/${market.slug}/shipping`}>Shipping</Link> ·{' '}
          <Link href={`/${market.slug}/privacy`}>Privacy</Link>
        </small>
      </div>
    </footer>
  );
}
