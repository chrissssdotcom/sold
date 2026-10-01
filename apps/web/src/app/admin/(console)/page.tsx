import Link from 'next/link';
import { getRuntime } from '../../../server/runtime';
import { dashboard } from '../../../server/admin/queries';
import { allowed, requireStaff } from '../../../server/admin/session';
import { PageHead, formatMinor } from '../_components/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

export default async function Dashboard() {
  const user = await requireStaff();
  if (!allowed(user, 'reports:read'))
    return (
      <>
        <PageHead title={`Welcome, ${user.name || user.email}`} />
        <p className="muted">Use the menu to open the areas you have access to.</p>
      </>
    );
  const d = await dashboard(getRuntime().db.primary);
  return (
    <>
      <PageHead title="Dashboard">
        <Link className="btn" href="/" target="_blank">
          View storefront
        </Link>
      </PageHead>
      <div className="grid cols-4">
        <div className="card stat">
          <div className="k">Orders, last 24 h</div>
          <div className="v">{d.orders24h}</div>
        </div>
        <div className="card stat">
          <div className="k">Revenue, last 24 h</div>
          <div className="v">
            {d.revenueCurrency ? formatMinor(d.revenue24h, d.revenueCurrency) : '—'}
          </div>
        </div>
        <div className="card stat">
          <div className="k">Awaiting payment</div>
          <div className="v">{d.pendingPayment}</div>
        </div>
        <div className="card stat">
          <div className="k">Active products</div>
          <div className="v">{d.activeProducts}</div>
        </div>
      </div>
      <h2 style={{ margin: '26px 0 12px' }}>Needs attention</h2>
      <div className="grid cols-2">
        <div className="card stat">
          <div className="k">Low or out of stock variants (≤ 5 available)</div>
          <div className={`v${d.lowStock > 0 ? ' warn' : ''}`}>{d.lowStock}</div>
          <Link href="/admin/products">Review products →</Link>
        </div>
        <div className="card stat">
          <div className="k">Emails failed or stuck (&gt; 10 min queued)</div>
          <div className={`v${d.emailsFailed + d.emailsStuck > 0 ? ' warn' : ''}`}>
            {d.emailsFailed + d.emailsStuck}
          </div>
          <span className="muted">
            A stuck queue usually means no email provider is configured.
          </span>
        </div>
        <div className="card stat">
          <div className="k">Payment events that need a person</div>
          <div className={`v${d.paymentsNeedingAttention > 0 ? ' warn' : ''}`}>
            {d.paymentsNeedingAttention}
          </div>
          <span className="muted">Amount mismatches and other flagged webhooks.</span>
        </div>
      </div>
    </>
  );
}
