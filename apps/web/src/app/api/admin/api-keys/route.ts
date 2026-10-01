import { z } from 'zod';
import { ValidationError } from '@sold/commerce';
import { createApiKey, listApiKeys } from '@sold/platform';
import { adminRoute } from '../../../../server/admin-route';
import { validateScopes } from '../../../../server/api-v1';
import { json } from '../../../../server/commerce-http';
import { body } from '../../../../server/admin/http';

export const dynamic = 'force-dynamic';

const input = z.strictObject({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string().max(60)).min(1).max(20),
  expiresInDays: z.number().int().min(1).max(730).optional(),
});

export const GET = adminRoute('settings:read', async (_req, { db }) =>
  json({ keys: await listApiKeys(db) }),
);

/** The only time the full key is ever shown. */
export const POST = adminRoute('settings:write', async (req, { db, audit, user }) => {
  const v = await body(req, input);
  const bad = validateScopes(v.scopes);
  if (bad.length > 0) throw new ValidationError('Unknown or too-broad scopes', { scopes: bad });
  const { token, record } = await createApiKey(db, {
    name: v.name,
    scopes: v.scopes,
    createdBy: user.email,
    ...(v.expiresInDays ? { expiresAt: new Date(Date.now() + v.expiresInDays * 86_400_000) } : {}),
  });
  await audit(
    'apikey.created',
    { type: 'api_key', id: record.id },
    { name: v.name, scopes: v.scopes },
  );
  return json({ token, key: record }, { status: 201 });
});
