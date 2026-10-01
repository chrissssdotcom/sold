import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { permissionFor } from '../../../../../../server/authorizer';
import { adminScreens } from '../../../../../../server/extension-ui';
import { allowed, requireStaff } from '../../../../../../server/admin/session';
import { PageHead } from '../../../../_components/ui';

export const dynamic = 'force-dynamic';

/**
 * Hosts an admin screen contributed by an extension, inside the console shell. The permission is checked here on the
 * server (the nav hiding a link is a convenience, not the control). The screen is a component the extension owns;
 * it talks to its own `/admin/x/<extension>/...` routes, which authorise independently.
 */
export default async function ExtensionScreen({
  params,
}: {
  params: Promise<{ extension: string; path?: string[] }>;
}) {
  const user = await requireStaff();
  const { extension, path } = await params;
  const wanted = `/${(path ?? []).join('/')}`;
  const screen = adminScreens().find(
    (s) => s.extension === extension && (s.path === wanted || (s.path === '/' && wanted === '/')),
  );
  if (!screen || !allowed(user, permissionFor(screen.permission))) notFound();
  const { default: loaded } = await screen.component();
  const Screen = loaded as unknown as () => ReactNode | Promise<ReactNode>;
  return (
    <>
      <PageHead title={screen.title} crumbs={[{ label: 'Extensions' }, { label: extension }]} />
      <Screen />
    </>
  );
}
