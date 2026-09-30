/**
 * Database access for extensions. The SDK re-exports Drizzle's table helpers so an extension and Base share
 * exactly one drizzle-orm instance (two copies break `instanceof` and type identity).
 *
 * Rules (enforced by lint and by the extension migration linter):
 * - Tables are named `ext_<name>_*` and live in the extension's own migrations.
 * - Never alter Base tables. To attach data to a Base entity use its `metadata jsonb` column or a side
 *   table with a foreign key to it.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export * as pg from 'drizzle-orm/pg-core';
export { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';

/** Drizzle handles with no Base schema attached: extensions bring their own tables. */
export interface ExtensionDb {
  /** Reads that tolerate replica lag. */
  replica: NodePgDatabase;
  /** Writes, and reads that need read-your-writes. */
  primary: NodePgDatabase;
}

/** Table-name prefix for an extension, e.g. `loyalty-points` -> `ext_loyalty_points_`. */
export function tablePrefix(extensionName: string): string {
  return `ext_${extensionName.replaceAll('-', '_')}_`;
}
