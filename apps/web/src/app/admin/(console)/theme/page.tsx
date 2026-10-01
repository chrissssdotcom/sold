import { allowed, requireStaff } from '../../../../server/admin/session';
import { PageHead } from '../../_components/ui';
import { ThemeEditor } from './editor';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Theme' };

export default async function ThemePage() {
  const user = await requireStaff();
  return (
    <>
      <PageHead title="Theme" />
      <ThemeEditor canWrite={allowed(user, 'theme:write')} />
    </>
  );
}
