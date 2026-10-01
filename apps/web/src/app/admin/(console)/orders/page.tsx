import Link from 'next/link';
import { getRuntime } from '../../../../server/runtime';
import { listOrders } from '../../../../server/admin/queries';
import { requireStaff } from '../../../../server/admin/session';
import { Empty, PageHead, Status, formatMinor, when } from '../../_components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Orders' };

const STATUSES = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
];

export default async function Orders({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; before?: string }>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const { items, nextCursor } = await listOrders(getRuntime().db.primary, {
    ...(sp.q ? { q: sp.q.slice(0, 100) } : {}),
    ...(sp.status && STATUSES.includes(sp.status) ? { status: sp.status } : {}),
    ...(sp.before && /^[0-9a-f-]{36}$/.test(sp.before) ? { before: sp.before } : {}),
  });
  const next =
    '?' +
    new URLSearchParams({
      ...(sp.q ? { q: sp.q } : {}),
      ...(sp.status ? { status: sp.status } : {}),
      ...(nextCursor ? { before: nextCursor } : {}),
    });
  return (
    <>
      <PageHead title="Orders" />
      <div className="card">
        <form className="card-h row" role="search">
          <label className="sr-only" htmlFor="q">
            Search orders
          </label>
          <input
            id="q"
            name="q"
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Order number or email"
            defaultValue={sp.q ?? ''}
          />
          <label className="sr-only" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            name="status"
            className="select"
            style={{ maxWidth: 190 }}
            defaultValue={sp.status ?? ''}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <button className="btn">Filter</button>
        </form>
        {items.length === 0 ? (
          <Empty>No orders match.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Placed</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <Link href={`/admin/orders/${o.id}`}>
                        <strong>#{o.number}</strong>
                      </Link>
                    </td>
                    <td>{o.email}</td>
                    <td>
                      <Status value={o.status} />
                    </td>
                    <td className="muted">{when(o.placedAt)}</td>
                    <td className="num">{formatMinor(o.total, o.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor ? (
          <div className="card-b">
            <Link className="btn" href={next}>
              Next page
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
