import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`sold_uuid_v7()`),
    dedupeKey: text('dedupe_key').notNull(),
    template: text('template').notNull(),
    toEmail: text('to_email').notNull(),
    locale: text('locale').notNull().default('en-au'),
    data: jsonb('data').notNull(),
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: ts('available_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
    lastError: text('last_error'),
    providerId: text('provider_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('notifications_dedupe_key_key').on(t.dedupeKey),
    index('notifications_due_idx')
      .on(t.availableAt)
      .where(sql`${t.status} in ('queued', 'sending')`),
  ],
);

export const emailSuppressions = pgTable('email_suppressions', {
  email: text('email').primaryKey(),
  reason: text('reason').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});
