import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { parseId } from '../../../../../../server/admin/http';
import { revalidatePath } from 'next/cache';
import { getPageService } from '../../../../../../server/admin/pages';

export const dynamic = 'force-dynamic';
export const POST = adminRoute('content:publish', async (req, { db, audit, user }) => {
  const parts = new URL(req.url).pathname.split('/');
  const id = parseId(parts[parts.length - 2]);
  await getPageService().unpublish(db, id, user.email);
  await audit('page.unpublished', { type: 'page', id });
  revalidatePath('/', 'layout');
  return json({ ok: true });
});
