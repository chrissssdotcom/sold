import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { lintMigrationDir } from '../lint';

// Lint Base migrations plus any extension migrations (extensions/*/migrations).
const root = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const dirs = [join(root, 'packages/db/migrations')];
const extRoot = join(root, 'extensions');
if (existsSync(extRoot)) {
  for (const name of await readdir(extRoot)) {
    const d = join(extRoot, name, 'migrations');
    if (existsSync(d)) dirs.push(d);
  }
}

let failed = 0;
for (const dir of dirs) {
  for (const report of await lintMigrationDir(dir)) {
    for (const f of report.findings) {
      failed++;
      console.error(`${report.file}:${f.line} [${f.rule}] ${f.message}\n    ${f.statement}`);
    }
  }
}
if (failed > 0) {
  console.error(
    `\n${failed} unsafe migration statement(s). See docs/runbooks/database.md for the expand/contract pattern.`,
  );
  process.exit(1);
}
console.log(`migration lint: ${dirs.length} director${dirs.length === 1 ? 'y' : 'ies'} clean`);
