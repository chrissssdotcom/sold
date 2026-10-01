import { createDb, sql } from '@sold/db';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

/**
 * `sold reporting:enable-login`: give the read-only `sold_grafana` role a login password, taken from GRAFANA_DB_PASSWORD
 * (never an argument: it would land in shell history and `ps`). Migrations create the role without a password on purpose;
 * this is the out-of-band step, run by whoever provisions the environment. Safe to re-run (rotates the password).
 */
export async function reportingEnableLogin(ctx: CliContext): Promise<void> {
  const url = ctx.env['DATABASE_MIGRATION_URL'] ?? ctx.env['DATABASE_URL'];
  if (!url)
    throw new CliError('DATABASE_URL (or DATABASE_MIGRATION_URL) is not set', ExitCode.usage);
  const password = ctx.env['GRAFANA_DB_PASSWORD'];
  if (!password) throw new CliError('Set GRAFANA_DB_PASSWORD in the environment', ExitCode.usage);
  const local = (ctx.env['SOLD_ENVIRONMENT'] ?? 'local') === 'local';
  if (!local && password.length < 20)
    throw new CliError(
      'GRAFANA_DB_PASSWORD must be at least 20 characters outside local development',
      ExitCode.usage,
    );
  if (ctx.dryRun) {
    ctx.out.info('would enable login for sold_grafana');
    return;
  }
  const db = createDb({ primaryUrl: url, poolMax: 1, applicationName: 'sold-cli' });
  try {
    // `format(%L)` quotes the literal server-side, so the password is never spliced into SQL text by us.
    const stmt = await db.primary.execute<{ ddl: string }>(
      sql`SELECT format('ALTER ROLE sold_grafana LOGIN PASSWORD %L', ${password}::text) AS ddl`,
    );
    await db.primary.execute(sql.raw(stmt.rows[0]!.ddl));
    ctx.out.info('sold_grafana can now log in (read-only, reporting schema only)');
  } catch (error) {
    if (String((error as { cause?: unknown }).cause ?? error).includes('does not exist'))
      throw new CliError(
        'The role does not exist yet: run `pnpm db:migrate` first',
        ExitCode.failure,
      );
    throw error;
  } finally {
    await db.close();
  }
}
