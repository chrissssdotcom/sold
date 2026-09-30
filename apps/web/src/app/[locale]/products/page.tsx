import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProductCard } from '../../../storefront/components/product-card';
import { getAvailability, getProducts } from '../../../storefront/lib/data';
import { marketFor } from '../../../storefront/lib/i18n';

export const revalidate = 60;
// Render on first request, then serve from the shared ISR cache (nothing is prerendered at build: no database needed).
export const generateStaticParams = () => [];
export const metadata: Metadata = {
  title: 'Shop everything',
  description: 'Every piece, made in small batches.',
};

export default async function ProductsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const products = await getProducts(48);
  const stock = await getAvailability(
    products
      .flatMap((p) => p.variants.map((v) => v.id))
      .sort()
      .join(','),
  );
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
