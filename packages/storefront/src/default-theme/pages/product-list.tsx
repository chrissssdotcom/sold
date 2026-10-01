import Link from 'next/link';
import type { ProductListPageProps } from '../../contract';

export function ProductListPage({ market, products, stock, theme }: ProductListPageProps) {
  const ProductCard = theme.components.ProductCard;
  return (
    <div className="container">
      <header className="page-head">
        <nav aria-label="Breadcrumb">
          <ol className="crumbs">
            <li>
              <Link href={`/${market.slug}`}>Home</Link>
            </li>
            <li aria-current="page">Shop</li>
          </ol>
        </nav>
        <h1>Shop everything</h1>
        <p className="lede" style={{ marginTop: '1rem' }}>
          {products.length} considered pieces, each made in small batches.
        </p>
      </header>
      <section id="new" aria-label="Products" style={{ paddingBottom: 'clamp(3rem,7vw,6rem)' }}>
        <div className="grid">
          {products.map((p, i) => (
            <ProductCard
              key={p.id}
              product={p}
              market={market}
              priority={i < 4}
              soldOut={p.variants.every((v) => stock.get(v.id)?.available === 0)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
