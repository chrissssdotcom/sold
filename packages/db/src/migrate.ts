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
  /** Per-statement lock wait inside a migration. Applied AFTER the runner lock is held. */
  lockTimeoutMs?: number;
  /** How long a second runner waits for the first to finish (rolling deploys). */
  runnerLockWaitMs?: number;
  onLog?: (message: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

const NO_TX_MARKER = /^\s*--\s*sold:no-transaction\b/m;
// A breakpoint is a whole line; a string literal that merely contains the text must never be split.
const BREAKPOINT_LINE = /^[ \t]*--> statement-breakpoint[ \t]*$/m;
const CONCURRENT_INDEX =
  /^\s*create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[a-z_][a-z0-9_$]*)/i;
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
    .split(new RegExp(BREAKPOINT_LINE.source, 'gm'))
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
    // Wait for any other runner FIRST (bounded, polling), and only then set the per-statement lock_timeout:
    // otherwise the lock timeout would also cap the wait for the runner lock and a second runner would
    // die while the first is still working through a slow migration.
    await client.query('SET statement_timeout = 0');
    await acquireRunnerLock(client, opts.runnerLockWaitMs ?? 600_000);
    // Migrations never inherit the app's 5s statement timeout, but never wait indefinitely for a hot-table lock.
    await client.query(`SET lock_timeout = '${Math.trunc(opts.lockTimeoutMs ?? 5_000)}ms'`);
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
          // Breakpoints are SQL comments: harmless in a transactional multi-statement query, so leave them intact.
          await client.query(file.sql);
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
          for (const statement of splitStatements(file.sql))
            await runNoTransactionStatement(client, statement);
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

async function acquireRunnerLock(client: Client, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      ADVISORY_LOCK_KEY,
    ]);
    if (rows[0]?.ok) return;
    if (Date.now() >= deadline)
      throw new Error(`Another migration runner held the lock for more than ${waitMs} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind. With `IF NOT EXISTS` a rerun would then
 * skip it and the migration would be journaled with an index that is never used (and, for UNIQUE, never
 * enforces anything). So: drop an invalid leftover before building, and verify validity afterwards.
 */
async function runNoTransactionStatement(client: Client, statement: string): Promise<void> {
  // Leading `--` comment lines (e.g. `-- sold:allow ...`) come before the statement keyword.
  const index = CONCURRENT_INDEX.exec(
    statement.replace(/^(?:\s*--[^\n]*\n)+/, ''),
  )?.[1]?.replaceAll('"', '');
  if (index) {
    const existing = await client.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
      [index],
    );
    if (existing.rows[0] && !existing.rows[0].valid)
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
  }
  await client.query(statement);
  if (index) {
    const built = await client.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
      [index],
    );
    if (!built.rows[0]?.valid)
      throw new Error(
        `Index "${index}" is invalid after CREATE INDEX CONCURRENTLY (a UNIQUE build hit duplicates, or it was cancelled)`,
      );
  }
}
