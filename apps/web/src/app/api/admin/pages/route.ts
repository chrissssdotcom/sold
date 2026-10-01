import { z } from 'zod';
import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { body } from '../../../../server/admin/http';
import * as q from '../../../../server/admin/queries';
import { getPageService } from '../../../../server/admin/pages';

export const dynamic = 'force-dynamic';
export const GET = adminRoute('content:read', async (_req, { db }) => json(await q.listPages(db)));

const create = z.strictObject({
  path: z.string().max(200),
  locale: z.string().max(10),
  title: z.string().max(200),
  seo: z.record(z.string(), z.unknown()).optional(),
});

export const POST = adminRoute('content:write', async (req, { db, audit, user }) => {
  const v = await body(req, create);
  const page = await getPageService().create(db, { ...v, seo: v.seo as never, actor: user.email });
  await audit(
    'page.created',
    { type: 'page', id: page.id },
    { path: page.path, locale: page.locale },
  );
  return json(page, { status: 201 });
});
