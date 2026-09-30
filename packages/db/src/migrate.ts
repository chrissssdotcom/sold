import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';

/**
 * Forward-only, online-safe migration runner.
 *
 * Why custom: drizzle's migrator applies everything in one transaction, which makes
 * `CREATE INDEX CONCURRENTLY` (required on hot tables, Section 8A.4) impossible. drizzle-kit is
 * still used to *author* SQL from the schema; this runner applies it.
 *
 * - `scope` is `base` or `ext:<name>`: a per-extension journal in one `_sold_migrations` table.
 * - Files apply in lexical order. Applied files are immutable (checksum verified).
 * - A file whose header contains `-- sold:no-transaction` runs one statement per
 *   `--> statement-breakpoint` chunk, outside a transaction (required for CONCURRENTLY).
 * - A session advisory lock serialises concurrent runners (rolling deploys).
 */

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

export interface MigrateOptions {
  /** Direct (non-pooled) connection string: migrations need session semantics. */
  url: string;
  dir: string;
  scope?: string;
  lockTimeoutMs?: number;
  onLog?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const NO_TX_MARKER = /^\s*--\s*sold:no-transaction\b/m;
const BREAKPOINT = '--> statement-breakpoint';
// Fixed key so every runner in every environment contends on the same lock.
const ADVISORY_LOCK_KEY = 7_265_034_211;

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    entries.map(async (name) => {
      const sql = await readFile(join(dir, name), 'utf8');
      const header = sql.split('\n').slice(0, 10).join('\n');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
        transactional: !NO_TX_MARKER.test(header),
      };
    }),
  );
}

export function splitStatements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS _sold_migrations (
  scope       text NOT NULL,
  name        text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, name)
)`;

export async function migrate(opts: MigrateOptions): Promise<MigrateResult> {
  const scope = opts.scope ?? 'base';
  const log = opts.onLog ?? (() => undefined);
  const files = await loadMigrations(opts.dir);
  const client = new Client({ connectionString: opts.url, application_name: 'sold-migrate' });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Migrations set their own limits: never inherit the app's 5s statement timeout, but never
    // wait indefinitely for a lock on a hot table either.
    await client.query('SET statement_timeout = 0');
    await client.query(`SET lock_timeout = '${Math.trunc(opts.lockTimeoutMs ?? 5_000)}ms'`);
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(JOURNAL_DDL);

    const done = new Map<string, string>(
      (
        await client.query<{ name: string; checksum: string }>(
          'SELECT name, checksum FROM _sold_migrations WHERE scope = $1',
          [scope],
        )
      ).rows.map((r) => [r.name, r.checksum]),
    );

    // Detect drift: a previously applied file that changed or disappeared.
    const known = new Set(files.map((f) => f.name));
    for (const name of done.keys()) {
      if (!known.has(name))
        throw new Error(`[${scope}] applied migration ${name} is missing from ${opts.dir}`);
    }
    let lastApplied = '';
    for (const f of files) if (done.has(f.name) && f.name > lastApplied) lastApplied = f.name;

    for (const file of files) {
      const existing = done.get(file.name);
      if (existing !== undefined) {
        if (existing !== file.checksum) {
          throw new Error(
            `[${scope}] migration ${file.name} was modified after it was applied (checksum mismatch)`,
          );
        }
        skipped.push(file.name);
        continue;
      }
      if (file.name < lastApplied) {
        throw new Error(
          `[${scope}] migration ${file.name} sorts before already-applied ${lastApplied}; migrations are forward-only`,
        );
      }
      const started = Date.now();
      log(`applying ${scope}/${file.name}${file.transactional ? '' : ' (no transaction)'}`);
      if (file.transactional) {
        await client.query('BEGIN');
        try {
          await client.query(file.sql.replaceAll(BREAKPOINT, ''));
          await record(client, scope, file, Date.now() - started);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`[${scope}] ${file.name} failed: ${(error as Error).message}`, {
            cause: error,
          });
        }
      } else {
        try {
          for (const statement of splitStatements(file.sql)) await client.query(statement);
        } catch (error) {
          throw new Error(
            `[${scope}] ${file.name} failed (no transaction, may be partially applied; statements must be idempotent): ${(error as Error).message}`,
            { cause: error },
          );
        }
        await record(client, scope, file, Date.now() - started);
      }
      applied.push(file.name);
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

async function record(
  client: Client,
  scope: string,
  file: MigrationFile,
  durationMs: number,
): Promise<void> {
  await client.query(
    'INSERT INTO _sold_migrations (scope, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
    [scope, file.name, file.checksum, durationMs],
  );
}
