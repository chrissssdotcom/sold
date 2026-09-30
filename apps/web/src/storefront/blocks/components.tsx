import Link from 'next/link';
import type { ReactNode } from 'react';
import type { z } from '@sold/extension-sdk';
import { Arrow, Leaf, Refresh, Shield, Star, Truck } from '../components/icons';
import { ProductCard } from '../components/product-card';
import { getAvailability, getProducts, getProductsByHandles } from '../lib/data';
import type { Market } from '../lib/i18n';
import type * as S from './schemas';

type P<T extends z.ZodType> = z.output<T> & { market: Market };

/** `*word*` -> accent italic. Plain string in, React nodes out: never dangerouslySetInnerHTML. */
function accent(text: string): ReactNode[] {
  return text
    .split(/(\*[^*]+\*)/g)
    .map((part, i) =>
      part.startsWith('*') && part.endsWith('*') && part.length > 2 ? (
        <em key={i}>{part.slice(1, -1)}</em>
      ) : (
        part
      ),
    );
}

const localHref = (m: Market, href: string) =>
  href.startsWith('/') ? `/${m.slug}${href === '/' ? '' : href}` : href;

export function Hero(p: P<typeof S.heroProps>) {
  return (
    <section className="hero">
      <div className="container hero__grid">
        <div>
          {p.eyebrow ? <span className="eyebrow reveal">{p.eyebrow}</span> : null}
          <h1 className="hero__title reveal reveal--2">{accent(p.heading)}</h1>
          {p.body ? <p className="lede reveal reveal--2">{p.body}</p> : null}
          <div className="hero__cta reveal reveal--3">
            {p.primary ? (
              <Link href={localHref(p.market, p.primary.href)} className="btn btn--primary btn--lg">
                {p.primary.label} <Arrow width={20} height={20} />
              </Link>
            ) : null}
            {p.secondary ? (
              <Link href={localHref(p.market, p.secondary.href)} className="btn btn--ghost btn--lg">
                {p.secondary.label}
              </Link>
            ) : null}
          </div>
          {p.proof ? (
            <p className="hero__proof reveal reveal--3">
              <span className="stars" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Star key={i} width={18} height={18} />
                ))}
              </span>
              {p.proof}
            </p>
          ) : null}
        </div>
        <div className="hero__art reveal reveal--2">
          <div className="hero__frame">
            <img src={p.image} alt="" width={1200} height={1000} fetchPriority="high" />
          </div>
          <div className="float-card float-card--a" aria-hidden="true">
            <span className="float-card__icon">
              <Truck width={22} height={22} />
            </span>
            <span>
              <strong>Free delivery</strong>on orders over{' '}
              {p.market.currency === 'USD' ? '$150' : 'A$150'}
            </span>
          </div>
          <div className="float-card float-card--b" aria-hidden="true">
            <span className="float-card__icon">
              <Leaf width={22} height={22} />
            </span>
            <span>
              <strong>Small batch</strong>made to last
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

const ICONS = { truck: Truck, leaf: Leaf, refresh: Refresh, shield: Shield } as const;

export function FeatureStrip(p: P<typeof S.featureStripProps>) {
  return (
    <div className="container">
      <ul className="features">
        {p.items.map((item) => {
          const Icon = ICONS[item.icon];
          return (
            <li key={item.title} className="feature">
              <span className="feature__icon">
                <Icon width={22} height={22} />
              </span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export async function ProductGrid(p: P<typeof S.productGridProps>) {
  const products =
    p.handles.length > 0
      ? await getProductsByHandles(p.handles.join(','))
      : (await getProducts(p.limit)).slice(0, p.limit);
  const stock = await getAvailability(
    products
      .flatMap((x) => x.variants.map((v) => v.id))
      .sort()
      .join(','),
  );
  return (
    <section className="section" id="new">
      <div className="container">
        {p.heading || p.viewAll ? (
          <div className="section__head">
            <div>
              {p.eyebrow ? <span className="eyebrow">{p.eyebrow}</span> : null}
              {p.heading ? <h2 className="h-section">{p.heading}</h2> : null}
            </div>
            {p.viewAll ? (
              <Link href={localHref(p.market, p.viewAll.href)} className="btn btn--ghost">
                {p.viewAll.label} <Arrow width={18} height={18} />
              </Link>
            ) : null}
          </div>
        ) : null}
        <div className="grid" style={{ ['--cols-max' as string]: p.columns }}>
          {products.map((product, i) => (
            <ProductCard
              key={product.id}
              product={product}
              market={p.market}
              priority={i < 4}
              soldOut={product.variants.every((v) => stock.get(v.id)?.available === 0)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

export function CategoryTiles(p: P<typeof S.categoryTilesProps>) {
  return (
    <section className="section">
      <div className="container">
        {p.heading ? (
          <div className="section__head">
            <div>
              {p.eyebrow ? <span className="eyebrow">{p.eyebrow}</span> : null}
              <h2 className="h-section">{p.heading}</h2>
            </div>
          </div>
        ) : null}
        <div className="tiles">
          {p.tiles.map((t) => (
            <Link key={t.label} href={localHref(p.market, t.href)} className="tile">
              <img src={t.image} alt="" loading="lazy" width={640} height={800} />
              <span className="tile__label">
                {t.label}
                <span className="tile__go">
                  <Arrow width={20} height={20} />
                </span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Editorial(p: P<typeof S.editorialProps>) {
  return (
    <section className={`section${p.tint ? ' section--tint' : ''}`}>
      <div className={`container split${p.reverse ? ' split--reverse' : ''}`}>
        <div className="split__media">
          <img src={p.image} alt="" loading="lazy" width={900} height={1000} />
        </div>
        <div className="split__text">
          {p.eyebrow ? <span className="eyebrow">{p.eyebrow}</span> : null}
          <h2>{accent(p.heading)}</h2>
          {p.body ? <p>{p.body}</p> : null}
          {p.cta ? (
            <Link href={localHref(p.market, p.cta.href)} className="btn btn--dark btn--lg">
              {p.cta.label} <Arrow width={20} height={20} />
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function Testimonial(p: P<typeof S.testimonialProps>) {
  return (
    <section className="section section--tint">
      <figure className="container quote">
        <span className="stars" role="img" aria-label="Five out of five stars">
          {[0, 1, 2, 3, 4].map((i) => (
            <Star key={i} width={22} height={22} />
          ))}
        </span>
        <blockquote>{p.quote}</blockquote>
        <figcaption>
          <strong>{p.author}</strong>
          {p.role ? ` · ${p.role}` : ''}
        </figcaption>
      </figure>
    </section>
  );
}

export function CtaBanner(p: P<typeof S.ctaBannerProps>) {
  return (
    <section className="section">
      <div className="container">
        <div className="cta-banner">
          <h2>{accent(p.heading)}</h2>
          {p.body ? <p>{p.body}</p> : null}
          {p.cta ? (
            <Link href={localHref(p.market, p.cta.href)} className="btn btn--primary btn--lg">
              {p.cta.label} <Arrow width={20} height={20} />
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function RichText(p: P<typeof S.richTextProps>) {
  const blocks = p.body
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  return (
    <section className="section">
      <div className="container">
        <div className="prose">
          {p.heading ? <h1>{p.heading}</h1> : null}
          {blocks.map((b, i) =>
            b.startsWith('## ') ? <h2 key={i}>{b.slice(3)}</h2> : <p key={i}>{b}</p>,
          )}
        </div>
      </div>
    </section>
  );
}

export function Spacer(p: P<typeof S.spacerProps>) {
  const h = { sm: '1.5rem', md: '3rem', lg: '6rem' }[p.size];
  return <div aria-hidden="true" style={{ height: h }} />;
}

export function Columns({ count, children }: { count: number; children?: ReactNode }) {
  return (
    <div className="container">
      <div className="grid" style={{ ['--cols-max' as string]: count }}>
        {children}
      </div>
    </div>
  );
}
