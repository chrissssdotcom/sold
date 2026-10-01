import Link from 'next/link';
import { getRuntime } from '../../../../server/runtime';
import { listProducts } from '../../../../server/admin/queries';
import { allowed, requireStaff } from '../../../../server/admin/session';
import { Empty, PageHead, Status } from '../../_components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Products' };

export default async function Products({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; before?: string }>;
}) {
  const user = await requireStaff();
  const sp = await searchParams;
  const { items, nextCursor } = await listProducts(getRuntime().db.primary, {
    ...(sp.q ? { q: sp.q.slice(0, 100) } : {}),
    ...(sp.status ? { status: sp.status } : {}),
    ...(sp.before && /^[0-9a-f-]{36}$/.test(sp.before) ? { before: sp.before } : {}),
  });
  const qs = (extra: Record<string, string>) =>
    '?' +
    new URLSearchParams({
      ...(sp.q ? { q: sp.q } : {}),
      ...(sp.status ? { status: sp.status } : {}),
      ...extra,
    });
  return (
    <>
      <PageHead title="Products">
        {allowed(user, 'catalog:write') ? (
          <Link className="btn primary" href="/admin/products/new">
            Add product
          </Link>
        ) : null}
      </PageHead>
      <div className="card">
        <form className="card-h row" role="search">
          <label className="sr-only" htmlFor="q">
            Search products
          </label>
          <input
            id="q"
            name="q"
            className="input"
            style={{ maxWidth: 320 }}
            placeholder="Search title or handle"
            defaultValue={sp.q ?? ''}
          />
          <label className="sr-only" htmlFor="status">
            Status
          </label>
          <select
            id="status"
            name="status"
            className="select"
            style={{ maxWidth: 160 }}
            defaultValue={sp.status ?? ''}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
          <button className="btn">Filter</button>
        </form>
        {items.length === 0 ? (
          <Empty>No products match.</Empty>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Products">
            <table className="t">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Status</th>
                  <th className="num">Variants</th>
                  <th className="num">On hand</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/admin/products/${p.id}`}>
                        <strong>{p.title}</strong>
                      </Link>
                      <div className="muted mono">{p.handle}</div>
                    </td>
                    <td>
                      <Status value={p.status} />
                    </td>
                    <td className="num">{p.variants}</td>
                    <td className="num">{p.onHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor ? (
          <div className="card-b">
            <Link className="btn" href={qs({ before: nextCursor })}>
              Next page
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
