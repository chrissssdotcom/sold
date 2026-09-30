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
 * first (the extension allowlist + online-safety rules, ADR-0004); nothing runs if any statement is unsafe. This is
 * the same lint gate CI runs, applied again at apply time so a release cannot skip it (defence in depth).
 */
export async function migrateExtension(
  opts: Omit<MigrateOptions, 'scope'> & {
    extension: string;
    /** Every other extension known to the instance: names in their (longer) namespaces are not this extension's. */
    knownExtensions?: readonly string[];
  },
): Promise<MigrateResult> {
  const reports = await lintExtensionMigrationDir(opts.dir, opts.extension, {
    otherExtensions: opts.knownExtensions ?? [],
  });
  const problems = reports.flatMap((r) =>
    r.findings.map((f) => `${r.file}:${f.line} [${f.rule}] ${f.message}`),
  );
  if (problems.length > 0) throw new UnsafeExtensionMigrationError(opts.extension, problems);
  const { extension, knownExtensions: _known, ...rest } = opts;
  return migrate({ ...rest, scope: `ext:${extension}` });
}

export { extensionPrefix };
