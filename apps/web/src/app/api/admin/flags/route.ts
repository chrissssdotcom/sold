import { z } from 'zod';
import { schema, sql } from '@sold/db';
import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { body } from '../../../../server/admin/http';

export const dynamic = 'force-dynamic';

const rules = z.strictObject({
  allowList: z.array(z.string().min(1).max(100)).max(500).optional(),
  rolloutPercent: z.number().min(0).max(100).optional(),
  variants: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z0-9_-]{1,30}$/),
        weight: z.number().min(0).max(1000),
      }),
    )
    .max(10)
    .refine((v) => new Set(v.map((x) => x.name)).size === v.length, 'variant names must be unique')
    .optional(),
});

const input = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9._-]{1,60}$/, 'lowercase letters, digits, dots, dashes'),
  enabled: z.boolean(),
  description: z.string().max(300).default(''),
  rules: rules.default({}),
});

export const GET = adminRoute('settings:read', async (_req, { db }) => {
  const rows = await db.select().from(schema.featureFlags).orderBy(schema.featureFlags.key);
  return json({ flags: rows });
});

/** Create or update a flag. Takes effect on every instance within the flag cache TTL (5 s): no deploy, no purge. */
export const PUT = adminRoute('settings:write', async (req, { db, audit }) => {
  const v = await body(req, input);
  await db.execute(sql`
    INSERT INTO feature_flags (key, enabled, rules, description) VALUES (${v.key}, ${v.enabled}, ${JSON.stringify(v.rules)}::jsonb, ${v.description})
    ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, rules = EXCLUDED.rules, description = EXCLUDED.description, updated_at = now()`);
  await audit('flag.set', { type: 'flag', id: v.key }, { enabled: v.enabled, rules: v.rules });
  return json({ ok: true });
});
