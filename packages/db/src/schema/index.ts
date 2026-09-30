import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * DB-backed feature flags (per environment: each environment has its own database).
 * Flag state is exportable as code for review (Section 8C.6).
 */
export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  /** Optional rollout rules (percentage, allow-list); validated by the flags service. */
  rules: jsonb('rules')
    .notNull()
    .default(sql`'{}'::jsonb`),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Transactional outbox (Section 7). Written in the same transaction as the state change,
 * published by a worker. RANGE-partitioned monthly on `created_at`; partitions are created
 * ahead and retired by `sold_maintain_partitions` (see migration 0000_init). Drizzle models it as
 * a plain table: the partitioning lives in SQL.
 * Scale gate (e): expected > 10M rows -> partitioned, 90-day retention for published rows.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id')
      .notNull()
      .default(sql`sold_uuid_v7()`),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    // Hot path: the publisher polls unpublished rows in availability order.
    index('outbox_events_unpublished_idx')
      .on(t.availableAt)
      .where(sql`${t.publishedAt} is null`),
  ],
);

/** Journal of applied migrations, per scope: `base` or `ext:<name>` (per-extension journal). */
export const migrationJournal = pgTable(
  '_sold_migrations',
  {
    scope: text('scope').notNull(),
    name: text('name').notNull(),
    checksum: text('checksum').notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer('duration_ms').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.scope, t.name] })],
);
