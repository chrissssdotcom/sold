import { schema } from '@sold/db';
import { getRuntime } from '../../../../server/runtime';
import { allowed, requireStaff } from '../../../../server/admin/session';
import { PageHead } from '../../_components/ui';
import { FlagsAdmin } from './admin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Feature flags' };

export default async function Flags() {
  const user = await requireStaff();
  const rows = await getRuntime()
    .db.primary.select()
    .from(schema.featureFlags)
    .orderBy(schema.featureFlags.key);
  return (
    <>
      <PageHead title="Feature flags" />
      <FlagsAdmin
        canWrite={allowed(user, 'settings:write')}
        flags={rows.map((r) => ({
          key: r.key,
          enabled: r.enabled,
          description: r.description,
          rules: r.rules as Record<string, unknown>,
        }))}
      />
    </>
  );
}
