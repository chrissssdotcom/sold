import Link from 'next/link';
import type { MarketProps } from '../../contract';

/** Shown when no home page has been published yet (a fresh instance), instead of a 404. */
export function HomeFallback({ market }: MarketProps) {
  return (
    <div className="container empty-state">
      <p className="eyebrow">Welcome</p>
      <h1 style={{ fontSize: 'var(--step-4)' }}>This store is almost ready</h1>
      <p className="lede">
        Publish a home page in the page builder, or browse what is already here.
      </p>
      <Link href={`/${market.slug}/products`} className="btn btn--primary btn--lg">
        Browse the shop
      </Link>
    </div>
  );
}
