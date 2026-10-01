import Link from 'next/link';
import { getKernel } from '../../../../server/kernel';
import { allowed, requireStaff } from '../../../../server/admin/session';
import { PageHead } from '../../_components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Extensions' };

export default async function Extensions() {
  const user = await requireStaff();
  const kernel = await getKernel();
  const canSettings = allowed(user, 'extensions:read');
  return (
    <>
      <PageHead title="Extensions" />
      <div className="card">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Extensions">
          <table className="t">
            <thead>
              <tr>
                <th>Extension</th>
                <th>Adds</th>
                <th>Origin</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {kernel.extensions.map((e) => {
                const m = e.manifest;
                const adds = [
                  m.routes.length && `${m.routes.length} routes`,
                  m.observers.length && `${m.observers.length} observers`,
                  m.blocks.length && `${m.blocks.length} blocks`,
                  m.slots.length && `${m.slots.length} slots`,
                  m.adminScreens.length && `${m.adminScreens.length} screens`,
                  m.jobs.length && `${m.jobs.length} jobs`,
                ].filter(Boolean);
                return (
                  <tr key={m.name}>
                    <td>
                      <strong>{m.name}</strong> <span className="muted">v{m.version}</span>
                      <div className="muted">{m.description}</div>
                    </td>
                    <td className="muted">{adds.join(' · ') || '—'}</td>
                    <td>
                      <span className="badge">{e.origin}</span>
                    </td>
                    <td className="num">
                      {canSettings && kernel.settings.has(m.name) ? (
                        <Link className="btn sm" href={`/admin/extensions/${m.name}`}>
                          Settings
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card-b muted">
          Enabling or disabling an extension is part of a release (
          <span className="mono">sold.config.ts</span> then{' '}
          <span className="mono">sold ext:sync</span>), not a click here: it changes code and
          database schema.
        </div>
      </div>
    </>
  );
}
