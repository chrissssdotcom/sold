import { z } from 'zod';
import { adminRoute } from '../../../../../server/admin-route';
import { json } from '../../../../../server/commerce-http';
import { body, parseId } from '../../../../../server/admin/http';
import { getPageService } from '../../../../../server/admin/pages';

export const dynamic = 'force-dynamic';
const segment = (req: Request) => new URL(req.url).pathname.split('/').pop();

export const GET = adminRoute('content:read', async (req, { db }) => {
  const id = parseId(segment(req));
  const svc = getPageService();
  const [latest, versions] = await Promise.all([svc.getLatest(db, id), svc.listVersions(db, id)]);
  return json({ ...latest, versions });
});

const save = z.strictObject({
  tree: z.unknown(),
  note: z.string().max(200).optional(),
  expectedVersion: z.number().int().min(0).optional(),
});

/** Saving appends a version; it never changes what is live. Publishing is a separate, separately-permissioned step. */
export const PUT = adminRoute('content:write', async (req, { db, audit, user }) => {
  const id = parseId(segment(req));
  const v = await body(req, save, 1024 * 1024);
  const saved = await getPageService().saveDraft(db, id, v.tree, {
    actor: user.email,
    ...(v.note ? { note: v.note } : {}),
    ...(v.expectedVersion !== undefined ? { expectedVersion: v.expectedVersion } : {}),
  });
  await audit('page.saved', { type: 'page', id }, { version: saved.version });
  return json(saved);
});

const meta = z.strictObject({
  title: z.string().min(1).max(200).optional(),
  seo: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = adminRoute('content:write', async (req, { db, audit }) => {
  const id = parseId(segment(req));
  const v = await body(req, meta);
  await getPageService().updateMeta(db, id, {
    ...(v.title !== undefined ? { title: v.title } : {}),
    ...(v.seo !== undefined ? { seo: v.seo as never } : {}),
  });
  await audit('page.meta', { type: 'page', id });
  return json({ ok: true });
});
