import { notFound } from 'next/navigation';
import { allowed, requireStaff } from '../../../../../server/admin/session';
import { PageHead } from '../../../_components/ui';
import { SettingsForm } from './form';

export const dynamic = 'force-dynamic';

export default async function ExtensionSettings({ params }: { params: Promise<{ name: string }> }) {
  const user = await requireStaff();
  const { name } = await params;
  if (!/^[a-z][a-z0-9-]{0,60}$/.test(name) || !allowed(user, 'extensions:read')) notFound();
  return (
    <>
      <PageHead
        title={`${name} settings`}
        crumbs={[{ label: 'Extensions', href: '/admin/extensions' }, { label: name }]}
      />
      <SettingsForm name={name} canWrite={allowed(user, 'extensions:write')} />
    </>
  );
}
