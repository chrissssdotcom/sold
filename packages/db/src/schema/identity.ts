import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`sold_uuid_v7()`);
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique('users_email_key'),
  name: text('name').notNull().default(''),
  kind: text('kind').notNull().default('customer'),
  status: text('status').notNull().default('active'),
  passwordHash: text('password_hash'),
  emailVerifiedAt: ts('email_verified_at'),
  externalId: text('external_id'),
  lastLoginAt: ts('last_login_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique('sessions_token_hash_key'),
  expiresAt: ts('expires_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  createdAt: ts('created_at').notNull().defaultNow(),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const roles = pgTable('roles', {
  name: text('name').primaryKey(),
  description: text('description').notNull().default(''),
  permissions: text('permissions')
    .array()
    .notNull()
    .default(sql`'{}'`),
  builtIn: boolean('built_in').notNull().default(false),
});

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleName: text('role_name')
      .notNull()
      .references(() => roles.name, { onDelete: 'cascade' }),
    grantedBy: text('granted_by').notNull().default('system'),
    grantedAt: ts('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleName] })],
);

export const identityLinks = pgTable(
  'identity_links',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.subject] })],
);

export const authThrottle = pgTable('auth_throttle', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStart: ts('window_start').notNull().defaultNow(),
  lockedUntil: ts('locked_until'),
});

export const scimTokens = pgTable('scim_tokens', {
  id: id(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique('scim_tokens_hash_key'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

export const auditLog = pgTable('audit_log', {
  id: id(),
  at: ts('at').notNull().defaultNow(),
  actorId: uuid('actor_id'),
  actorLabel: text('actor_label').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull().default(''),
  targetId: text('target_id').notNull().default(''),
  detail: jsonb('detail')
    .notNull()
    .default(sql`'{}'::jsonb`),
  ip: text('ip'),
});
