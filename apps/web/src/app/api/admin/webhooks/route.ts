import { z } from 'zod';
import { ValidationError } from '@sold/commerce';
import { schema, sql } from '@sold/db';
import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { body } from '../../../../server/admin/http';
import { getRuntime } from '../../../../server/runtime';
import { WEBHOOK_EVENTS, buildWebhooks } from '../../../../server/platform';

export const dynamic = 'force-dynamic';

const input = z.strictObject({
  url: z.string().max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  description: z.string().max(200).default(''),
});

export const GET = adminRoute('settings:read', async (_req, { db }) => {
  const endpoints = await db
    .select({
      id: schema.webhookEndpoints.id,
      url: schema.webhookEndpoints.url,
      events: schema.webhookEndpoints.events,
      active: schema.webhookEndpoints.active,
      description: schema.webhookEndpoints.description,
      createdAt: schema.webhookEndpoints.createdAt,
    })
    .from(schema.webhookEndpoints)
    .orderBy(sql`created_at DESC`)
    .limit(100);
  const recent = await db.execute<{
    id: string;
    endpoint_id: string;
    event_type: string;
    status: string;
    attempts: number;
    last_status: number | null;
    last_error: string | null;
    created_at: string;
  }>(
    sql`SELECT id, endpoint_id, event_type, status, attempts, last_status, last_error, created_at FROM webhook_deliveries ORDER BY created_at DESC LIMIT 50`,
  );
  return json({ endpoints, deliveries: recent.rows, events: WEBHOOK_EVENTS });
});

/** The signing secret is returned once, here, and never again. */
export const POST = adminRoute('settings:write', async (req, { db, audit, user }) => {
  const v = await body(req, input);
  try {
    const { id, secret } = await buildWebhooks(getRuntime().env).createEndpoint(db, {
      ...v,
      createdBy: user.email,
    });
    await audit('webhook.created', { type: 'webhook', id }, { url: v.url, events: v.events });
    return json({ id, secret }, { status: 201 });
  } catch (error) {
    if ((error as Error).name === 'WebhookConfigError')
      throw new ValidationError((error as Error).message);
    throw error;
  }
});
