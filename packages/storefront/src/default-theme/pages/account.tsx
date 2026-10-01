'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AccountPageProps } from '../../contract';
import { formatMoney } from '../../kit/money';

/** The signed-in customer's home: their orders. Data arrives as props; the only action here is signing out. */
export function AccountPage({ market, customer, orders, slots }: AccountPageProps) {
  const router = useRouter();
  const base = `/${market.slug}`;
  return (
    <div className="container" style={{ maxWidth: '46rem', marginBlock: '3rem' }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}
      >
        <div>
          <h1 style={{ fontSize: 'var(--step-3)' }}>
            Hello{customer.name ? `, ${customer.name}` : ''}
          </h1>
          <p className="muted">{customer.email}</p>
        </div>
        <button
          className="btn btn--ghost"
          onClick={async () => {
            await fetch('/api/auth/logout', { method: 'POST' });
            router.push(base);
            router.refresh();
          }}
        >
          Sign out
        </button>
      </div>
      <section className="panel" aria-labelledby="orders-h" style={{ marginTop: '1.5rem' }}>
        <h2 id="orders-h">Your orders</h2>
        {orders.length === 0 ? (
          <p className="muted">
            Nothing yet. <Link href={`${base}/products`}>Find something you love</Link>.
          </p>
        ) : (
          <ul>
            {orders.map((o) => (
              <li key={o.id} className="sum" style={{ paddingBlock: '0.6rem' }}>
                <span>
                  <strong>#{o.number}</strong>{' '}
                  <span className="muted">
                    {new Date(o.placedAt).toLocaleDateString(market.tag)} ·{' '}
                    {o.status.replace(/_/g, ' ')}
                  </span>
                </span>
                <span>{formatMoney(o.total, market.tag)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {slots?.dashboard}
    </div>
  );
}
