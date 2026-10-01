import Link from 'next/link';
import type { ProductCardProps } from '@sold/storefront';
import { Price, fromPrice, viewOf } from '@sold/storefront/kit';

/** Image-led card: the name and price sit over the picture instead of beneath it. */
export function ProductCard({
  product,
  market,
  soldOut = false,
  priority = false,
}: ProductCardProps) {
  const v = viewOf(product);
  const price = fromPrice(product, market.currency);
  return (
    <article className="noir-card">
      <Link
        href={`/${market.slug}/products/${product.handle}`}
        className="noir-card__link"
        aria-label={v.title}
      >
        {v.images[0] ? (
          <img
            src={v.images[0]}
            alt=""
            width={640}
            height={800}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : null}
        <span className="noir-card__shade" />
        <span className="noir-card__text">
          <span className="noir-card__title">{v.title}</span>
          {soldOut ? (
            <span className="noir-card__price">Sold out</span>
          ) : price ? (
            <Price
              price={price.price}
              compareAt={price.compareAt}
              tag={market.tag}
              from={price.varies}
            />
          ) : null}
        </span>
      </Link>
    </article>
  );
}
