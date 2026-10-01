import Link from 'next/link';
import { getRuntime } from '../../../../server/runtime';
import { listAudit } from '../../../../server/admin/queries';
import { requireStaff } from '../../../../server/admin/session';
import { Empty, PageHead, when } from '../../_components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Audit log' };

export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; before?: string }>;
}) {
  await requireStaff();
  const sp = await searchParams;
  const { items, nextCursor } = await listAudit(getRuntime().db.primary, {
    ...(sp.action ? { action: sp.action.slice(0, 60) } : {}),
    ...(sp.before && /^[0-9a-f-]{36}$/.test(sp.before) ? { before: sp.before } : {}),
  });
  return (
    <>
      <PageHead title="Audit log" />
      <div className="card">
        <form className="card-h row" role="search">
          <label className="sr-only" htmlFor="action">
            Action prefix
          </label>
          <input
            id="action"
            name="action"
            className="input"
            style={{ maxWidth: 280 }}
            placeholder="Action, e.g. order. or page."
            defaultValue={sp.action ?? ''}
          />
          <button className="btn">Filter</button>
        </form>
        {items.length === 0 ? (
          <Empty>No entries.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {when(a.at)}
                    </td>
                    <td>{a.actorLabel}</td>
                    <td className="mono">{a.action}</td>
                    <td className="mono muted">
                      {a.targetType ? `${a.targetType}:${String(a.targetId).slice(0, 8)}` : '—'}
                    </td>
                    <td
                      className="mono muted"
                      style={{
                        maxWidth: 320,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {Object.keys(a.detail as object).length ? JSON.stringify(a.detail) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {nextCursor ? (
          <div className="card-b">
            <Link
              className="btn"
              href={`?${new URLSearchParams({ ...(sp.action ? { action: sp.action } : {}), before: nextCursor })}`}
            >
              Older entries
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
