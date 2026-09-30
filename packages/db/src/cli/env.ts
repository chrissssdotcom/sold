/**
 * Minimal environment access for the DB CLIs. `@sold/db` sits below `@sold/core` in the dependency graph
 * (apps/web -> core -> db), so it must not import core's env schema.
 */
export function databaseUrls(env: Record<string, string | undefined> = process.env): {
  url: string;
  environment: string;
} {
  const url = env.DATABASE_MIGRATION_URL || env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL (or DATABASE_MIGRATION_URL) is required.');
    process.exit(1);
  }
  return { url, environment: env.SOLD_ENVIRONMENT ?? 'local' };
}
