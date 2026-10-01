import { notFound } from 'next/navigation';
import { getCommerce } from '../../../../../server/commerce';
import { getRuntime } from '../../../../../server/runtime';
import { orderPayments } from '../../../../../server/admin/queries';
import { allowed, requireStaff } from '../../../../../server/admin/session';
import { PageHead, Status, formatMinor, when } from '../../../_components/ui';
import { OrderActions } from './actions';

export const dynamic = 'force-dynamic';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const db = getRuntime().db.primary;
  const { orders } = await getCommerce();
  const order = await orders.get(db, id).catch(() => null);
  if (!order) notFound();
  const payments = await orderPayments(db, id);
  const addr = order.shippingAddress as Record<string, string> | null;
  return (
    <>
      <PageHead
        title={`Order #${order.number}`}
        crumbs={[{ label: 'Orders', href: '/admin/orders' }, { label: `#${order.number}` }]}
      >
        <Status value={order.status} />
      </PageHead>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="grid">
          <section className="card" aria-labelledby="items">
            <div className="card-h">
              <h2 id="items">Items</h2>
              <span className="muted">Placed {when(order.placedAt)}</span>
            </div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Unit</th>
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.title}
                        <div className="muted mono">{l.sku}</div>
                      </td>
                      <td className="num">{l.quantity}</td>
                      <td className="num">{formatMinor(l.unitPrice.amount, order.currency)}</td>
                      <td className="num">{formatMinor(l.lineTotal.amount, order.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="card-b kv">
              <dt>Subtotal</dt>
              <dd>{formatMinor(order.subtotal.amount, order.currency)}</dd>
              <dt>Discounts</dt>
              <dd>−{formatMinor(order.discountTotal.amount, order.currency)}</dd>
              <dt>Shipping</dt>
              <dd>{formatMinor(order.shippingTotal.amount, order.currency)}</dd>
              <dt>Tax</dt>
              <dd>{formatMinor(order.taxTotal.amount, order.currency)}</dd>
              <dt>
                <strong>Total</strong>
              </dt>
              <dd>
                <strong>{formatMinor(order.total.amount, order.currency)}</strong>
              </dd>
            </dl>
          </section>
          <section className="card" aria-labelledby="pay">
            <div className="card-h">
              <h2 id="pay">Payments</h2>
            </div>
            {payments.length === 0 ? (
              <div className="empty">No payment started yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Gateway</th>
                      <th>Status</th>
                      <th className="num">Captured</th>
                      <th className="num">Refunded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td>{p.gateway}</td>
                        <td>
                          <Status value={p.status} />
                        </td>
                        <td className="num">{formatMinor(p.captured, p.currency)}</td>
                        <td className="num">{formatMinor(p.refunded, p.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
        <div className="grid">
          <section className="card" aria-labelledby="cust">
            <div className="card-h">
              <h2 id="cust">Customer</h2>
            </div>
            <dl className="card-b kv">
              <dt>Email</dt>
              <dd>{order.email}</dd>
              <dt>Ship to</dt>
              <dd>
                {addr
                  ? [
                      addr['name'],
                      addr['line1'],
                      addr['city'],
                      addr['region'],
                      addr['postcode'],
                      addr['country'],
                    ]
                      .filter(Boolean)
                      .join(', ')
                  : '—'}
              </dd>
              <dt>Method</dt>
              <dd>{order.shippingMethod ?? '—'}</dd>
            </dl>
          </section>
          <OrderActions
            orderId={order.id}
            status={order.status}
            currency={order.currency}
            payments={payments.map((p) => ({
              id: p.id,
              gateway: p.gateway,
              status: p.status,
              refundable: (BigInt(p.captured) - BigInt(p.refunded)).toString(),
            }))}
            can={{
              fulfil: allowed(user, 'orders:fulfil'),
              cancel: allowed(user, 'orders:cancel'),
              refund: allowed(user, 'payments:refund'),
              confirm: allowed(user, 'orders:write'),
            }}
          />
        </div>
      </div>
    </>
  );
}
