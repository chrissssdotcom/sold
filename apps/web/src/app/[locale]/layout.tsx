import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';
import { darkTokensCss } from '@sold/storefront';
import { markets, marketFor } from '@sold/storefront/i18n';
import { CartProvider } from '@sold/storefront/kit';
import instanceConfig from '../../../../../sold.config';
import { getThemeTokens } from '../../storefront/data';
import { theme } from '../../storefront/theme';

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

/**
 * The shell. It owns routing, the cart provider and token injection; everything visible comes from the active theme's
 * components, so swapping a theme (or one component of it) never touches this file.
 */
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
  const site = { name: instanceConfig.instance.name };
  const { Announcement, Header, Footer, CartDrawer } = theme.components;
  // Theme tokens, then operator overrides from the admin. Values were validated (they become CSS custom properties).
  const tokens = { ...theme.tokens, ...(await getThemeTokens()) } as CSSProperties;
  const dark = darkTokensCss(theme);
  return (
    <html lang={market.tag} style={tokens} data-theme-name={theme.name}>
      <head>{dark ? <style dangerouslySetInnerHTML={{ __html: dark }} /> : null}</head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <CartProvider currency={market.currency}>
          <Announcement market={market} />
          <Header market={market} site={site} />
          <main id="main">{children}</main>
          <Footer market={market} site={site} />
          <CartDrawer market={market} />
        </CartProvider>
      </body>
    </html>
  );
}
