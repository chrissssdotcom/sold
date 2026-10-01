import Link from 'next/link';
import { Arrow, type BaseBlockProps } from '@sold/storefront';

type HeroProps = BaseBlockProps['hero'];

/** Same block type and props as the default hero (so existing pages keep working), drawn full-bleed. */
export function Hero({ ctx, heading, eyebrow, body, primary, secondary, image }: HeroProps) {
  const href = (h: string) => (h.startsWith('/') ? `/${ctx.market.slug}${h === '/' ? '' : h}` : h);
  const parts = heading.split(/(\*[^*]+\*)/g);
  return (
    <section
      className="noir-hero"
      style={{
        backgroundImage: `linear-gradient(90deg, #0e0d0c 8%, #0e0d0cb3 45%, transparent), url(${image})`,
      }}
    >
      <div className="container noir-hero__inner">
        {eyebrow ? <p className="noir-hero__eyebrow">{eyebrow}</p> : null}
        <h1 className="noir-hero__title">
          {parts.map((p, i) =>
            p.startsWith('*') && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em> : p,
          )}
        </h1>
        {body ? <p className="noir-hero__body">{body}</p> : null}
        <div className="noir-hero__cta">
          {primary ? (
            <Link href={href(primary.href)} className="btn btn--primary btn--lg">
              {primary.label} <Arrow width={20} height={20} />
            </Link>
          ) : null}
          {secondary ? (
            <Link href={href(secondary.href)} className="btn btn--ghost btn--lg">
              {secondary.label}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
