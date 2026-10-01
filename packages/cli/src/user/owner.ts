import { createDb } from '@sold/db';
import { AuthService, SessionService, bootstrapOwner } from '@sold/identity';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

/**
 * `sold user:create-owner --email you@example.com`: first-run setup and recovery. Prints a generated password once (or uses
 * SOLD_OWNER_PASSWORD from the environment: never a command-line argument, which would land in shell history and `ps`).
 */
export async function userCreateOwner(
  ctx: CliContext,
  options: { email: string; name?: string },
): Promise<void> {
  const url = ctx.env['DATABASE_MIGRATION_URL'] ?? ctx.env['DATABASE_URL'];
  if (!url)
    throw new CliError('DATABASE_URL (or DATABASE_MIGRATION_URL) is not set', ExitCode.usage);
  if (ctx.dryRun) {
    ctx.out.info(`would ensure an owner account for ${options.email}`);
    return;
  }
  const db = createDb({ primaryUrl: url, poolMax: 2, applicationName: 'sold-cli' });
  try {
    const password = ctx.env['SOLD_OWNER_PASSWORD'];
    const result = await bootstrapOwner(db.primary, new AuthService(new SessionService()), {
      email: options.email,
      ...(options.name ? { name: options.name } : {}),
      ...(password ? { password } : {}),
    });
    if (!result.created)
      ctx.out.info(
        `${result.user.email} already existed: ensured active and owner. Password unchanged.`,
      );
    else if (result.generatedPassword) {
      ctx.out.info(`created owner ${result.user.email}`);
      ctx.out.info(
        `password (shown once, change it after signing in): ${result.generatedPassword}`,
      );
    } else
      ctx.out.info(`created owner ${result.user.email} with the password from SOLD_OWNER_PASSWORD`);
  } catch (error) {
    const e = error as { code?: string; message?: string };
    if (e.code) throw new CliError(`${e.message ?? 'failed'} (${e.code})`, ExitCode.refused);
    throw error;
  } finally {
    await db.close();
  }
}
