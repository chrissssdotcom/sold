import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import * as q from '../../../../server/admin/queries';

export const dynamic = 'force-dynamic';
export const GET = adminRoute('reports:read', async (_req, { db }) => json(await q.dashboard(db)));
