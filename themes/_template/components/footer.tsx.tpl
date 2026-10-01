import type { ChromeProps } from '@sold/storefront';

/** An example override: replace the footer, keep everything else. Delete or rewrite freely. */
export function Footer({ market, site }: ChromeProps) {
  return (
    <footer className="site-footer">
      <div className="container footer__base" style={{ marginTop: 0 }}>
        <small>
          © {new Date().getFullYear()} {site.name}. Prices in {market.currency}.
        </small>
        <small>Styled with the __TITLE__ theme</small>
      </div>
    </footer>
  );
}
