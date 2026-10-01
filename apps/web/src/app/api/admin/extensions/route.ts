import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { getKernel } from '../../../../server/kernel';

export const dynamic = 'force-dynamic';

/** Installed extensions and what each contributes. Read-only: enabling/disabling is a release-pipeline step (`sold ext:*`). */
export const GET = adminRoute('extensions:read', async () => {
  const kernel = await getKernel();
  const rows = kernel.extensions.map((e) => ({
    name: e.manifest.name,
    version: e.manifest.version,
    description: e.manifest.description,
    origin: e.origin,
    enabled: true,
    hasSettings: kernel.settings.has(e.manifest.name),
    contributes: {
      routes: e.manifest.routes.length,
      observers: e.manifest.observers.length,
      blocks: e.manifest.blocks.length,
      slots: e.manifest.slots.length,
      adminScreens: e.manifest.adminScreens.length,
      jobs: e.manifest.jobs.length,
    },
    permissions: e.manifest.permissions.map((p) => p.key),
  }));
  return json({
    extensions: rows,
    disabled: kernel.disabledNames,
    degraded: kernel.health().settings.degraded,
  });
});
