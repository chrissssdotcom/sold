import Link from 'next/link';
import { getRuntime } from '../../../../server/runtime';
import { listPages } from '../../../../server/admin/queries';
import { allowed, requireStaff } from '../../../../server/admin/session';
import { Empty, PageHead, Status, when } from '../../_components/ui';
import { NewPage } from './new-page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pages' };

export default async function Pages() {
  const user = await requireStaff();
  const rows = await listPages(getRuntime().db.primary);
  return (
    <>
      <PageHead title="Pages" />
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <div className="card" style={{ gridColumn: 'span 1' }}>
          {rows.length === 0 ? (
            <Empty>No pages yet.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Page</th>
                    <th>Locale</th>
                    <th>Status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/admin/pages/${r.id}`}>
                          <strong>{r.title}</strong>
                        </Link>
                        <div className="muted mono">{r.path}</div>
                      </td>
                      <td>{r.locale}</td>
                      <td>
                        <Status value={r.status} />
                      </td>
                      <td className="muted">{when(r.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {allowed(user, 'content:write') ? <NewPage /> : null}
      </div>
    </>
  );
}
