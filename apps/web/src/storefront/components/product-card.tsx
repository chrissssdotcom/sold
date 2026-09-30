import Link from 'next/link';
import type { CatalogProduct } from '@sold/commerce';
import { fromPrice, viewOf } from '../lib/product';
import type { Market } from '../lib/i18n';
import { QuickAdd } from './add-to-cart';
import { Price } from './price';

export function ProductCard({
  product,
  market,
  soldOut = false,
  priority = false,
}: {
  product: CatalogProduct;
  market: Market;
  soldOut?: boolean;
  priority?: boolean;
}) {
  const v = viewOf(product);
  const price = fromPrice(product, market.currency);
  const single = product.variants.length === 1 ? product.variants[0] : undefined;
  const href = `/${market.slug}/products/${product.handle}`;
  const onSale = price?.compareAt && BigInt(price.compareAt.amount) > BigInt(price.price.amount);
  const badge = soldOut ? 'Sold out' : onSale ? 'Sale' : v.badge;
  return (
    <article className="card">
      <div className="card__figure">
        <Link href={href} className="card__media" aria-label={v.title}>
          {v.images[0] ? (
            <img
              src={v.images[0]}
              alt=""
              width={640}
              height={800}
              loading={priority ? 'eager' : 'lazy'}
              decoding="async"
              {...(priority ? { fetchPriority: 'high' as const } : {})}
            />
          ) : null}
          {badge ? <span className={`badge${soldOut ? ' badge--muted' : ''}`}>{badge}</span> : null}
        </Link>
        {single && !soldOut && price ? <QuickAdd variantId={single.id} label={v.title} /> : null}
      </div>
      <div className="card__body">
        <h3 className="card__title">
          <Link href={href}>{v.title}</Link>
        </h3>
        {v.subtitle ? <p className="card__sub">{v.subtitle}</p> : null}
        {price ? (
          <Price
            price={price.price}
            compareAt={price.compareAt}
            tag={market.tag}
            from={price.varies}
          />
        ) : (
          <span className="muted">Not available in {market.currency}</span>
        )}
      </div>
    </article>
  );
}
