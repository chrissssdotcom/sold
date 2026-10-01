import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`sold_uuid_v7()`);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [unique('api_keys_prefix_key').on(t.prefix)],
);

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: id(),
  url: text('url').notNull(),
  events: text('events').array().notNull(),
  secretEnc: text('secret_enc').notNull(),
  active: boolean('active').notNull().default(true),
  description: text('description').notNull().default(''),
  createdBy: text('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: ts('available_at').notNull().defaultNow(),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    deliveredAt: ts('delivered_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('webhook_deliveries_once').on(t.endpointId, t.eventId),
    index('webhook_deliveries_due_idx')
      .on(t.availableAt)
      .where(sql`${t.status} in ('pending', 'delivering')`),
    index('webhook_deliveries_endpoint_idx').on(t.endpointId, t.createdAt.desc()),
  ],
);
