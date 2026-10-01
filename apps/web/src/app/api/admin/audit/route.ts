import { z } from 'zod';
import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { queryOf } from '../../../../server/admin/http';
import * as q from '../../../../server/admin/queries';

export const dynamic = 'force-dynamic';
const query = z.object({
  action: z.string().max(60).optional(),
  actor: z.string().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.uuid().optional(),
});

export const GET = adminRoute('audit:read', async (req, { db }) =>
  json(await q.listAudit(db, query.parse(queryOf(req)))),
);
