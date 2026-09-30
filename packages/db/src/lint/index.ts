import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lintExtensionStatements } from './extension';
import { parseMigration, SqlSyntaxError } from './parser';
import { lintStatements, rules, type Finding } from './rules';

export { rules, type Finding } from './rules';
export { extensionPrefix } from './extension';
export { SqlSyntaxError } from './parser';

export interface FileReport {
  file: string;
  findings: Finding[];
}

const NO_TX = /^\s*--\s*sold:no-transaction\b/m;
const hasNoTransactionHeader = (sql: string) => NO_TX.test(sql.split('\n').slice(0, 10).join('\n'));

const syntaxFinding = (error: unknown): Finding => ({
  rule: 'syntax-error',
  message: error instanceof SqlSyntaxError ? error.message : String(error),
  line: 1,
  statement: '',
});

/** Lint one migration. Async because the PostgreSQL parser is loaded lazily (WASM). */
export async function lintMigrationSql(sql: string): Promise<Finding[]> {
  try {
    const statements = await parseMigration(sql);
    return lintStatements(statements, { noTransaction: hasNoTransactionHeader(sql), source: sql });
  } catch (error) {
    return [syntaxFinding(error)];
  }
}

/** Lint one extension migration: online-safety rules plus the extension namespace rules. */
export async function lintExtensionMigrationSql(
  sql: string,
  extension: string,
): Promise<Finding[]> {
  try {
    const statements = await parseMigration(sql);
    return await lintExtensionStatements(statements, extension, {
      noTransaction: hasNoTransactionHeader(sql),
      source: sql,
    });
  } catch (error) {
    return [syntaxFinding(error)];
  }
}

async function lintDir(
  dir: string,
  lint: (sql: string) => Promise<Finding[]>,
): Promise<FileReport[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const reports: FileReport[] = [];
  for (const file of files)
    reports.push({
      file: join(dir, file),
      findings: await lint(await readFile(join(dir, file), 'utf8')),
    });
  return reports;
}

export const lintMigrationDir = (dir: string): Promise<FileReport[]> =>
  lintDir(dir, lintMigrationSql);
export const lintExtensionMigrationDir = (dir: string, extension: string): Promise<FileReport[]> =>
  lintDir(dir, (sql) => lintExtensionMigrationSql(sql, extension));

export function describeRules(): string[] {
  return rules.map((r) => `${r.id}: ${r.describe}`);
}
