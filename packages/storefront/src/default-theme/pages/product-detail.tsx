import Link from 'next/link';
import type { ProductDetailPageProps } from '../../contract';
import { Check, Leaf, Refresh, Truck } from '../../kit/icons';
import { priceIn, viewOf } from '../../kit/product';
import { BuyBox } from '../components/buy-box';

export function ProductDetailPage({
  market,
  product,
  stock,
  related,
  relatedStock,
  theme,
}: ProductDetailPageProps) {
  const ProductCard = theme.components.ProductCard;
  const v = viewOf(product);
  const variants = product.variants.map((x) => {
    const p = priceIn(x, market.currency);
    return {
      id: x.id,
      title: x.title,
      price: p?.price ?? null,
      compareAt: p?.compareAt ?? null,
      available: stock.get(x.id)?.available ?? 0,
    };
  });
  const free = market.currency === 'USD' ? '$150' : 'A$150';
  return (
    <div className="container">
      <nav aria-label="Breadcrumb" className="page-head" style={{ paddingBottom: '1.25rem' }}>
        <ol className="crumbs" style={{ margin: 0 }}>
          <li>
            <Link href={`/${market.slug}`}>Home</Link>
          </li>
          <li>
            <Link href={`/${market.slug}/products`}>Shop</Link>
          </li>
          <li aria-current="page">{v.title}</li>
        </ol>
      </nav>
      <div className="pdp">
        <div className="pdp__gallery">
          <div className="pdp__main">
            {v.images[0] ? (
              <img src={v.images[0]} alt={v.title} width={900} height={1125} fetchPriority="high" />
            ) : null}
          </div>
        </div>
        <div className="pdp__info">
          <div>
            {v.collection ? <span className="eyebrow">{v.collection}</span> : null}
            <h1 className="pdp__title" style={{ marginTop: '0.6rem' }}>
              {v.title}
            </h1>
            {v.subtitle ? <p className="pdp__sub">{v.subtitle}</p> : null}
          </div>
          <BuyBox variants={variants} tag={market.tag} productTitle={v.title} />
          {v.description ? <p style={{ color: 'var(--ink-2)' }}>{v.description}</p> : null}
          {v.highlights.length > 0 ? (
            <ul className="highlights" aria-label="Highlights">
              {v.highlights.map((h) => (
                <li key={h}>
                  <Check width={20} height={20} />
                  {h}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="assure">
            <div>
              <Truck width={22} height={22} />
              Free delivery over {free}
            </div>
            <div>
              <Refresh width={22} height={22} />
              30-day easy returns
            </div>
            <div>
              <Leaf width={22} height={22} />
              Made in small batches
            </div>
          </div>
        </div>
      </div>
      {related.length > 0 ? (
        <section style={{ paddingBottom: 'clamp(3rem,7vw,6rem)' }} aria-labelledby="related">
          <div className="section__head">
            <h2 id="related" className="h-section" style={{ marginTop: 0 }}>
              You may also love
            </h2>
          </div>
          <div className="grid">
            {related.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                market={market}
                soldOut={p.variants.every((x) => relatedStock.get(x.id)?.available === 0)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
