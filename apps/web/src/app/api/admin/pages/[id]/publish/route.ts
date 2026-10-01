import { z } from 'zod';
import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { body, parseId } from '../../../../../../server/admin/http';
import { revalidatePath } from 'next/cache';
import { getPageService } from '../../../../../../server/admin/pages';

export const dynamic = 'force-dynamic';
const input = z.strictObject({ version: z.number().int().min(1) });

/** Publish (or roll back to) a version: one pointer move. The outbox event and an immediate cache purge make it live fast. */
export const POST = adminRoute('content:publish', async (req, { db, audit, user }) => {
  const parts = new URL(req.url).pathname.split('/');
  const id = parseId(parts[parts.length - 2]);
  const v = await body(req, input);
  await getPageService().publish(db, id, v.version, user.email);
  await audit('page.published', { type: 'page', id }, { version: v.version });
  revalidatePath('/', 'layout');
  return json({ ok: true });
});
