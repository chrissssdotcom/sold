import { allowed, requireStaff } from '../../../../server/admin/session';
import { PageHead } from '../../_components/ui';
import { MediaLibrary } from './library';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Media' };

export default async function MediaPage() {
  const user = await requireStaff();
  return (
    <>
      <PageHead title="Media" />
      <MediaLibrary canWrite={allowed(user, 'content:write')} />
    </>
  );
}
