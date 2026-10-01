import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { PageRenderer } from '@sold/storefront/blocks';
import { marketFor } from '@sold/storefront/i18n';
import { can } from '@sold/identity';
import { and, eq, schema } from '@sold/db';
import { getPageService } from '../../../../server/admin/pages';
import { currentSession } from '../../../../server/identity';
import { getRuntime } from '../../../../server/runtime';
import { storefrontData } from '../../../../storefront/data';
import { blockRegistry, theme } from '../../../../storefront/theme';

// Never cached, never indexed, only for signed-in staff: a draft must not be reachable by anyone else.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function Preview({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ v?: string }>;
}) {
  const { locale, id } = await params;
  const { v } = await searchParams;
  const market = marketFor(locale);
  if (!market || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const jar = await cookies();
  const header = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const session = await currentSession(header, 'staff');
  if (!session || !can(session.user.permissions, 'content:read')) notFound();
  const db = getRuntime().db.primary;
  const svc = getPageService();
  let tree = (await svc.getLatest(db, id).catch(() => null))?.tree;
  if (v && /^\d{1,6}$/.test(v)) {
    const [row] = await db
      .select({ tree: schema.pageVersions.tree })
      .from(schema.pageVersions)
      .where(and(eq(schema.pageVersions.pageId, id), eq(schema.pageVersions.version, Number(v))));
    if (row) tree = row.tree as typeof tree;
  }
  if (!tree) notFound();
  return (
    <PageRenderer
      tree={tree}
      registry={blockRegistry()}
      ctx={{ market, data: storefrontData, theme }}
    />
  );
}
