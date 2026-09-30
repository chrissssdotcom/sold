import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const pages = pgTable('pages', {
  id: uuid('id')
    .primaryKey()
    .default(sql`sold_uuid_v7()`),
  path: text('path').notNull(),
  locale: text('locale').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('draft'),
  publishedVersionId: uuid('published_version_id').references((): AnyPgColumn => pageVersions.id, {
    onDelete: 'restrict',
  }),
  seo: jsonb('seo')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pageVersions = pgTable('page_versions', {
  id: uuid('id')
    .primaryKey()
    .default(sql`sold_uuid_v7()`),
  pageId: uuid('page_id')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  tree: jsonb('tree').notNull(),
  note: text('note').notNull().default(''),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const themeSettings = pgTable('theme_settings', {
  id: boolean('id').primaryKey().default(true),
  preset: text('preset').notNull().default('default'),
  tokens: jsonb('tokens')
    .notNull()
    .default(sql`'{}'::jsonb`),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull().default('system'),
});
