import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BuyBox } from '../../../../storefront/components/buy-box';
import { Check, Leaf, Refresh, Truck } from '../../../../storefront/components/icons';
import { ProductCard } from '../../../../storefront/components/product-card';
import { getAvailability, getProduct, getProducts } from '../../../../storefront/lib/data';
import { marketFor } from '../../../../storefront/lib/i18n';
import { priceIn, viewOf } from '../../../../storefront/lib/product';

export const revalidate = 60;
// Render on first request, then serve from the shared ISR cache (nothing is prerendered at build: no database needed).
export const generateStaticParams = () => [];

type Params = Promise<{ locale: string; handle: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, handle } = await params;
  const p = await getProduct(handle);
  if (!p) return {};
  const v = viewOf(p);
  return {
    title: v.title,
    description: v.subtitle || v.description.slice(0, 155),
    alternates: { canonical: `/${locale}/products/${handle}` },
    openGraph: { title: v.title, description: v.subtitle, images: v.images },
  };
}

export default async function ProductPage({ params }: { params: Params }) {
  const { locale, handle } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const product = await getProduct(handle);
  if (!product) notFound();
  const v = viewOf(product);
  const stock = await getAvailability(
    product.variants
      .map((x) => x.id)
      .sort()
      .join(','),
  );
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
  const related = (await getProducts(8)).filter((p) => p.handle !== handle).slice(0, 4);
  const relatedStock = await getAvailability(
    related
      .flatMap((p) => p.variants.map((x) => x.id))
      .sort()
      .join(','),
  );

  const low = variants
    .filter((x) => x.price)
    .sort((a, b) => Number(BigInt(a.price!.amount) - BigInt(b.price!.amount)))[0];
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: v.title,
    description: v.description,
    image: v.images,
    sku: product.variants[0]?.sku,
    offers: variants
      .filter((x) => x.price)
      .map((x) => ({
        '@type': 'Offer',
        price: (
          Number(BigInt(x.price!.amount)) /
          10 **
            (new Intl.NumberFormat('en', {
              style: 'currency',
              currency: x.price!.currency,
            }).resolvedOptions().maximumFractionDigits ?? 2)
        ).toFixed(2),
        priceCurrency: x.price!.currency,
        availability:
          x.available === 0 ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      })),
  };
  void low;

  return (
    <div className="container">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
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
              <img
                src={v.images[0]}
                alt={`${v.title}`}
                width={900}
                height={1125}
                fetchPriority="high"
              />
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
              Free delivery over {market.currency === 'USD' ? '$150' : 'A$150'}
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
