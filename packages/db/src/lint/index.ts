import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lintStatements, rules, type Finding } from './rules';
import { splitSql } from './sql';

export { rules, type Finding } from './rules';
export { splitSql, normalize } from './sql';

export interface FileReport {
  file: string;
  findings: Finding[];
}

export function lintMigrationSql(sql: string): Finding[] {
  const header = sql.split('\n').slice(0, 10).join('\n');
  const noTransaction = /^\s*--\s*sold:no-transaction\b/m.test(header);
  return lintStatements(splitSql(sql), { noTransaction });
}

export async function lintMigrationDir(dir: string): Promise<FileReport[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const reports: FileReport[] = [];
  for (const file of files) {
    reports.push({
      file: join(dir, file),
      findings: lintMigrationSql(await readFile(join(dir, file), 'utf8')),
    });
  }
  return reports;
}

export function describeRules(): string[] {
  return rules.map((r) => `${r.id}: ${r.describe}`);
}
