import Link from 'next/link';
import type { MarketProps } from '../../contract';

export function NotFoundPage({ market }: Partial<MarketProps>) {
  return (
    <div className="container empty-state">
      <p className="eyebrow">404</p>
      <h1 style={{ fontSize: 'var(--step-4)' }}>We couldn’t find that page</h1>
      <p className="lede">
        It may have moved, or it never existed. Let’s get you back to something lovely.
      </p>
      <Link href={market ? `/${market.slug}` : '/'} className="btn btn--primary btn--lg">
        Back to the shop
      </Link>
    </div>
  );
}
