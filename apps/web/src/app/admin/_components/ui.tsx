import type { ReactNode } from 'react';
import Link from 'next/link';

export function PageHead({
  title,
  crumbs,
  children,
}: {
  title: string;
  crumbs?: { label: string; href?: string }[];
  children?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {crumbs?.length ? (
          <nav className="crumbs muted" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={c.label}>
                {i > 0 ? ' / ' : ''}
                {c.href ? <Link href={c.href}>{c.label}</Link> : c.label}
              </span>
            ))}
          </nav>
        ) : null}
        <h1>{title}</h1>
      </div>
      {children ? <div className="actions">{children}</div> : null}
    </header>
  );
}

const TONES: Record<string, string> = {
  active: 'ok',
  published: 'ok',
  paid: 'ok',
  delivered: 'ok',
  shipped: 'info',
  processing: 'info',
  pending_payment: 'warn',
  draft: '',
  archived: '',
  cancelled: 'bad',
  refunded: 'bad',
  disabled: 'bad',
  failed: 'bad',
};
export const Status = ({ value }: { value: string }) => (
  <span className={`badge ${TONES[value] ?? ''}`}>{value.replace(/_/g, ' ')}</span>
);

/** Money in minor units -> display text. Uses Intl for the currency's own exponent (JPY 0, AUD 2). */
export function formatMinor(amount: string | bigint, currency: string, locale = 'en-AU'): string {
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  const n = BigInt(amount);
  const div = 10n ** BigInt(digits);
  const major = Number(n / div) + Number(n % div) / Number(div);
  return fmt.format(major);
}

export const when = (d: Date | string | null | undefined): string =>
  d
    ? new Date(d).toLocaleString('en-AU', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }) + ' UTC'
    : '—';

export const Empty = ({ children }: { children: ReactNode }) => (
  <div className="empty">{children}</div>
);
