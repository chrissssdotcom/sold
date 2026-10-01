'use client';

import { usePathname } from 'next/navigation';
import { markets } from '../../kit/i18n';
import { Globe } from '../../kit/icons';

/** Switch market by swapping the locale prefix; a plain link, so it works without JS and keeps the current page. */
export function MarketSwitcher({ current }: { current: string }) {
  const path = usePathname() ?? '/';
  const rest = path.replace(/^\/[a-z]{2}-[a-z]{2}/, '') || '';
  return (
    <details className="market">
      <summary className="icon-btn market__btn" aria-label="Change country or region">
        <Globe />
        <span className="market__code">{markets.find((m) => m.slug === current)?.short}</span>
      </summary>
      <ul className="market__menu">
        {markets.map((m) => (
          <li key={m.slug}>
            <a
              href={`/${m.slug}${rest}`}
              aria-current={m.slug === current ? 'true' : undefined}
              hrefLang={m.tag}
            >
              <span>{m.label}</span>
              <span className="muted">{m.currency}</span>
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
