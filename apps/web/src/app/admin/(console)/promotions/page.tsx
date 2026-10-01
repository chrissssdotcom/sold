import { getRuntime } from '../../../../server/runtime';
import { listPromotions } from '../../../../server/admin/queries';
import { allowed, requireStaff } from '../../../../server/admin/session';
import { Empty, PageHead, when } from '../../_components/ui';
import { PromotionsAdmin } from './admin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Promotions' };

export default async function Promotions() {
  const user = await requireStaff();
  const rows = await listPromotions(getRuntime().db.primary);
  return (
    <>
      <PageHead title="Promotions" />
      <PromotionsAdmin
        canWrite={allowed(user, 'promotions:write')}
        rows={rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          active: r.active,
          usage: `${r.usageCount}${r.usageLimit ? ` / ${r.usageLimit}` : ''}`,
          ends: r.endsAt ? when(r.endsAt) : '—',
          kind: String((r.definition as { kind?: string }).kind ?? ''),
        }))}
      />
      {rows.length === 0 ? <Empty>No promotions yet.</Empty> : null}
    </>
  );
}
