import { notFound } from 'next/navigation';
import { getRuntime } from '../../../../../server/runtime';
import { pageReader } from '../../../../../server/admin/page-reader';
import { allowed, requireStaff } from '../../../../../server/admin/session';
import { PageHead, Status } from '../../../_components/ui';
import { Editor } from './editor';

export const dynamic = 'force-dynamic';

export default async function PageEditor({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  if (!allowed(user, 'content:read')) notFound();
  const db = getRuntime().db.primary;
  const svc = pageReader;
  const latest = await svc.getLatest(db, id).catch(() => null);
  if (!latest) notFound();
  const versions = await svc.listVersions(db, id);
  return (
    <>
      <PageHead
        title={latest.page.title}
        crumbs={[{ label: 'Pages', href: '/admin/pages' }, { label: latest.page.path }]}
      >
        <Status value={latest.page.status} />
      </PageHead>
      <Editor
        pageId={id}
        locale={latest.page.locale}
        path={latest.page.path}
        initialTree={latest.tree}
        initialVersion={latest.version}
        publishedVersionId={latest.page.publishedVersionId}
        versions={versions.map((v) => ({
          id: v.id,
          version: v.version,
          note: v.note,
          by: v.createdBy,
          at: v.createdAt.toISOString(),
        }))}
        canWrite={allowed(user, 'content:write')}
        canPublish={allowed(user, 'content:publish')}
      />
    </>
  );
}
