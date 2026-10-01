import { getRuntime } from '../../../../server/runtime';
import { getIdentity } from '../../../../server/identity';
import { listStaff } from '../../../../server/admin/queries';
import { allowed, requireStaff } from '../../../../server/admin/session';
import { basePermissions } from '@sold/identity';
import { PageHead } from '../../_components/ui';
import { UsersAdmin } from './admin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Staff & roles' };

export default async function Users() {
  const user = await requireStaff();
  const db = getRuntime().db.primary;
  const [staff, roles] = await Promise.all([listStaff(db), getIdentity().roles.list(db)]);
  return (
    <>
      <PageHead title="Staff & roles" />
      <UsersAdmin
        me={user.id}
        staff={staff.map((s) => ({ ...s, lastLoginAt: s.lastLoginAt?.toISOString() ?? null }))}
        roles={roles.map((r) => ({
          name: r.name,
          description: r.description,
          permissions: r.permissions,
          builtIn: r.builtIn,
        }))}
        areas={Object.fromEntries(Object.entries(basePermissions).map(([k, v]) => [k, [...v]]))}
        canWrite={allowed(user, 'users:write')}
        canRoles={allowed(user, 'users:roles')}
      />
    </>
  );
}
