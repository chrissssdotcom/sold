import { z } from 'zod';
import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { body } from '../../../../server/admin/http';
import * as q from '../../../../server/admin/queries';
import { revalidatePath } from 'next/cache';
import { validateTokens } from '@sold/storefront';
import { ConflictError } from '@sold/commerce';

export const dynamic = 'force-dynamic';
export const GET = adminRoute('theme:read', async (_req, { db }) =>
  json(await q.getThemeSettings(db)),
);

const input = z.strictObject({
  tokens: z.record(z.string().regex(/^--[a-z][a-z0-9-]*$/), z.string().max(200)),
  expectedVersion: z.number().int().min(0).optional(),
});

/** Design tokens only (colours, radii, fonts): validated against the same allow-list the storefront enforces on read. */
export const PUT = adminRoute('theme:write', async (req, { db, audit, user }) => {
  const v = await body(req, input);
  validateTokens(v.tokens, 'admin');
  const version = await q.setThemeSettings(db, v.tokens, user.email, v.expectedVersion);
  if (version === null)
    throw new ConflictError('theme_conflict', 'The theme changed since you loaded it; reload');
  await audit('theme.tokens', { type: 'theme', id: 'tokens' }, { keys: Object.keys(v.tokens) });
  revalidatePath('/', 'layout');
  return json({ version });
});
