import { extensionPrefix, lintExtensionMigrationDir } from './lint';
import { migrate, type MigrateOptions, type MigrateResult } from './migrate';

export class UnsafeExtensionMigrationError extends Error {
  constructor(
    public readonly extension: string,
    public readonly problems: string[],
  ) {
    super(
      `Extension "${extension}" has unsafe migrations:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'UnsafeExtensionMigrationError';
  }
}

/**
 * Apply an extension's migrations under its own journal scope (`ext:<name>`). The migrations are linted
 * first (namespace + online-safety rules); nothing runs if any statement is unsafe, so an extension can
 * neither touch Base tables nor lock a hot one.
 */
export async function migrateExtension(
  opts: Omit<MigrateOptions, 'scope'> & { extension: string },
): Promise<MigrateResult> {
  const reports = await lintExtensionMigrationDir(opts.dir, opts.extension);
  const problems = reports.flatMap((r) =>
    r.findings.map((f) => `${r.file}:${f.line} [${f.rule}] ${f.message}`),
  );
  if (problems.length > 0) throw new UnsafeExtensionMigrationError(opts.extension, problems);
  const { extension, ...rest } = opts;
  return migrate({ ...rest, scope: `ext:${extension}` });
}

export { extensionPrefix };
