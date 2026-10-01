import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { marketFor } from '@sold/storefront/i18n';
import { viewOf } from '@sold/storefront/kit';
import { getProduct, storefrontData } from '../../../../storefront/data';
import { ExtensionSlot } from '../../../../server/extension-ui';
import { theme } from '../../../../storefront/theme';

export const revalidate = 60;
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
  const stock = await storefrontData.availability(product.variants.map((x) => x.id));
  const related = (await storefrontData.products(8)).filter((p) => p.handle !== handle).slice(0, 4);
  const relatedStock = await storefrontData.availability(
    related.flatMap((p) => p.variants.map((x) => x.id)),
  );

  // Structured data is SEO plumbing Base owns, independent of how the theme draws the page.
  const v = viewOf(product);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: v.title,
    description: v.description,
    image: v.images,
    sku: product.variants[0]?.sku,
    offers: product.variants.flatMap((x) =>
      x.prices
        .filter((p) => p.currency === market.currency)
        .map((p) => ({
          '@type': 'Offer',
          price: p.amount.toDecimalString(),
          priceCurrency: p.currency,
          availability:
            stock.get(x.id)?.available === 0
              ? 'https://schema.org/OutOfStock'
              : 'https://schema.org/InStock',
        })),
    ),
  };
  const { ProductDetailPage } = theme.components;
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <ProductDetailPage
        market={market}
        product={product}
        stock={stock}
        related={related}
        relatedStock={relatedStock}
        theme={theme}
        slots={{
          aside: <ExtensionSlot name="product.detail.aside" props={{ productId: product.id }} />,
        }}
      />
    </>
  );
}
