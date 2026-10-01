import { allowed, requireStaff } from '../../../../server/admin/session';
import { PageHead } from '../../_components/ui';
import { Developers } from './admin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Developers' };

export default async function DevelopersPage() {
  const user = await requireStaff();
  return (
    <>
      <PageHead title="Developers">
        <a className="btn" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
          OpenAPI spec
        </a>
      </PageHead>
      <Developers canWrite={allowed(user, 'settings:write')} />
    </>
  );
}
