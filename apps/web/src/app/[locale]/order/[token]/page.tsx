import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { verifyOrderToken } from '../../../../server/cart-token';
import { cartKey, getCommerce } from '../../../../server/commerce';
import { getRuntime } from '../../../../server/runtime';
import { Arrow, Check } from '../../../../storefront/components/icons';
import { PayInstructions } from '../../../../storefront/components/pay-now';
import { marketFor } from '../../../../storefront/lib/i18n';
import { formatMoney } from '../../../../storefront/lib/money';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Order confirmed',
  robots: { index: false, follow: false },
};

export default async function OrderPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  const market = marketFor(locale);
  if (!market) notFound();
  const id = verifyOrderToken(cartKey(), token);
  if (!id) notFound();
  const { orders } = await getCommerce();
  const o = await orders.get(getRuntime().db.primary, id).catch(() => null);
  if (!o) notFound();
  const money = (m: { toJSON(): { amount: string; currency: string } }) =>
    formatMoney(m.toJSON(), market.tag);
  const pending = o.status === 'pending_payment';
  return (
    <div className="container" style={{ maxWidth: '46rem' }}>
      <div className="success">
        <span className="success__mark">
          <Check width={40} height={40} />
        </span>
        <h1 style={{ fontSize: 'var(--step-4)' }}>Thank you!</h1>
        <p className="lede">
          Order <strong>#{o.number}</strong> is{' '}
          {pending ? 'placed and waiting for payment' : 'confirmed'}. A receipt is on its way to{' '}
          {o.email}.
        </p>
      </div>
      {pending ? <PayInstructions token={token} /> : null}
      <section className="panel" aria-labelledby="summary" style={{ marginTop: '1.5rem' }}>
        <h2 id="summary">Order summary</h2>
        <ul>
          {o.lines.map((l) => (
            <li key={l.id} className="sum" style={{ paddingBlock: '0.5rem' }}>
              <span>
                {l.title} <span className="muted">× {l.quantity}</span>
              </span>
              <span>{money(l.lineTotal)}</span>
            </li>
          ))}
        </ul>
        <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '1rem 0' }} />
        <div className="sum">
          <span>Items</span>
          <span>{money(o.subtotal)}</span>
        </div>
        {o.discountTotal.amount > 0n ? (
          <div className="sum sum--discount">
            <span>Discounts</span>
            <span>−{money(o.discountTotal)}</span>
          </div>
        ) : null}
        <div className="sum">
          <span>Delivery</span>
          <span>{o.shippingTotal.amount === 0n ? 'Free' : money(o.shippingTotal)}</span>
        </div>
        <div className="sum muted small">
          <span>Includes tax of</span>
          <span>{money(o.taxTotal)}</span>
        </div>
        <div className="sum sum--total">
          <span>Total</span>
          <strong>{money(o.total)}</strong>
        </div>
      </section>
      <p className="center" style={{ margin: '2rem 0 4rem' }}>
        <Link href={`/${market.slug}/products`} className="btn btn--dark btn--lg">
          Keep shopping <Arrow width={20} height={20} />
        </Link>
      </p>
    </div>
  );
}
