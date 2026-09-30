export * from './client';
export * as schema from './schema';
export * from './flags';
export * from './seed';
export * from './maintenance';
export * from './extension-migrations';
// Query operators are re-exported so consumers share this package's single drizzle-orm instance.
export { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
export { migrate, loadMigrations, type MigrateOptions, type MigrateResult } from './migrate';
