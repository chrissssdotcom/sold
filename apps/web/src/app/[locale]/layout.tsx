import '@fontsource-variable/fraunces';
import '@fontsource-variable/fraunces/wght-italic.css';
import '@fontsource-variable/inter';
import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import instanceConfig from '../../../../../sold.config';
import { CartDrawer } from '../../storefront/components/cart-drawer';
import { CartProvider } from '../../storefront/components/cart-provider';
import { Announcement, SiteFooter, SiteHeader } from '../../storefront/components/site-chrome';
import { marketFor, markets } from '../../storefront/lib/i18n';
import '../../storefront/styles/storefront.css';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf6ef' },
    { media: '(prefers-color-scheme: dark)', color: '#15110e' },
  ],
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const name = instanceConfig.instance.name;
  return {
    metadataBase: new URL(process.env['SOLD_PUBLIC_URL'] ?? 'http://localhost:3000'),
    title: { default: name, template: `%s · ${name}` },
    description: 'Considered objects for everyday rituals.',
    alternates: {
      languages: Object.fromEntries(markets.map((m) => [m.tag, `/${m.slug}`])),
      canonical: `/${locale}`,
    },
    openGraph: {
      siteName: name,
      locale: marketFor(locale)?.tag.replace('-', '_') ?? 'en_AU',
      type: 'website',
    },
  };
}

export default async function StoreLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const name = instanceConfig.instance.name;
  return (
    <html lang={market.tag}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <CartProvider currency={market.currency}>
          <Announcement>
            Free delivery on orders over{' '}
            <strong>{market.currency === 'USD' ? '$150' : 'A$150'}</strong> · 30-day returns
          </Announcement>
          <SiteHeader market={market} name={name} />
          <main id="main">{children}</main>
          <SiteFooter market={market} name={name} />
          <CartDrawer tag={market.tag} base={`/${market.slug}`} />
        </CartProvider>
      </body>
    </html>
  );
}
