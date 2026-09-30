import { normalize, type Statement } from './sql';

export interface Finding {
  rule: string;
  message: string;
  line: number;
  statement: string;
}

export interface RuleContext {
  /** Tables created earlier in the same migration: brand-new tables cannot be contended. */
  newTables: Set<string>;
  /** Whether the file is declared `-- sold:no-transaction`. */
  noTransaction: boolean;
}

export interface Rule {
  id: string;
  describe: string;
  check(norm: string, ctx: RuleContext): string | null;
}

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$.]*)`;

function tableOf(norm: string, re: RegExp): string | null {
  const m = re.exec(norm);
  return m?.[1] ? m[1].replaceAll('"', '').replace(/^public\./, '') : null;
}

const alterTable = (norm: string) =>
  tableOf(norm, new RegExp(String.raw`^alter table (?:if exists )?(?:only )?(${IDENT})`));

const onExistingTable = (norm: string, ctx: RuleContext) => {
  const t = alterTable(norm);
  return t !== null && !ctx.newTables.has(t);
};

export const rules: Rule[] = [
  {
    id: 'index-not-concurrent',
    describe:
      'CREATE INDEX on an existing table must use CONCURRENTLY (a plain build blocks writes)',
    check(norm, ctx) {
      const m = new RegExp(
        String.raw`^create (?:unique )?index (?!concurrently)(?:if not exists )?(?:${IDENT} )?on (?:only )?(${IDENT})`,
      ).exec(norm);
      if (!m) return null;
      const table = (m[1] ?? '').replaceAll('"', '').replace(/^public\./, '');
      return ctx.newTables.has(table)
        ? null
        : `Use CREATE INDEX CONCURRENTLY IF NOT EXISTS on "${table}" in a "-- sold:no-transaction" migration.`;
    },
  },
  {
    id: 'drop-index-not-concurrent',
    describe: 'DROP INDEX must use CONCURRENTLY',
    check: (norm) =>
      /^drop index (?!concurrently)/.test(norm) ? 'Use DROP INDEX CONCURRENTLY IF EXISTS.' : null,
  },
  {
    id: 'concurrent-if-not-exists',
    describe:
      'Concurrent index builds must be idempotent (IF NOT EXISTS): a failed build leaves an invalid index and reruns must be safe',
    check: (norm) =>
      /^create (?:unique )?index concurrently (?!if not exists)/.test(norm)
        ? 'Add IF NOT EXISTS so a rerun after failure is safe.'
        : null,
  },
  {
    id: 'add-column-not-null-no-default',
    describe: 'ADD COLUMN ... NOT NULL without DEFAULT fails on populated tables',
    check(norm, ctx) {
      if (!onExistingTable(norm, ctx)) return null;
      return /\badd (?:column )?(?:if not exists )?\S+ [^,]*\bnot null\b/.test(norm) &&
        !/\bdefault\b/.test(norm)
        ? 'Add the column nullable (or with a constant DEFAULT), backfill in batches, then add a CHECK ... NOT VALID / VALIDATE.'
        : null;
    },
  },
  {
    id: 'add-column-volatile-default',
    describe: 'ADD COLUMN with a volatile DEFAULT rewrites the table',
    check(norm, ctx) {
      if (!onExistingTable(norm, ctx)) return null;
      return /\badd (?:column )?[^,]*\bdefault [^,]*\b(?:random|gen_random_uuid|uuid_generate_v\d|sold_uuid_v7|clock_timestamp|nextval|timeofday)\s*\(/.test(
        norm,
      )
        ? 'A volatile DEFAULT forces a full table rewrite under an ACCESS EXCLUSIVE lock. Add the column without a default and backfill in batches.'
        : null;
    },
  },
  {
    id: 'alter-column-type',
    describe: 'ALTER COLUMN TYPE usually rewrites the table',
    check: (norm, ctx) =>
      onExistingTable(norm, ctx) && /\balter (?:column )?\S+ (?:set data )?type\b/.test(norm)
        ? 'Use expand/contract: add a new column, dual-write, backfill in batches, switch reads, drop the old column in a later release.'
        : null,
  },
  {
    id: 'set-not-null',
    describe: 'SET NOT NULL scans the table under an ACCESS EXCLUSIVE lock',
    check: (norm, ctx) =>
      onExistingTable(norm, ctx) && /\balter (?:column )?\S+ set not null\b/.test(norm)
        ? 'Add CHECK (col IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL (PostgreSQL 12+ skips the scan).'
        : null,
  },
  {
    id: 'add-constraint-not-valid',
    describe:
      'FOREIGN KEY / CHECK constraints on existing tables must be added NOT VALID and validated separately',
    check: (norm, ctx) =>
      onExistingTable(norm, ctx) &&
      /\badd (?:constraint \S+ )?(?:foreign key|check)\b/.test(norm) &&
      !/\bnot valid\b/.test(norm)
        ? 'Add the constraint NOT VALID, then ALTER TABLE ... VALIDATE CONSTRAINT in a separate statement.'
        : null,
  },
  {
    id: 'add-unique-or-pk',
    describe: 'ADD UNIQUE / PRIMARY KEY builds an index under lock',
    check: (norm, ctx) =>
      onExistingTable(norm, ctx) &&
      /\badd (?:constraint \S+ )?(?:unique|primary key)\b/.test(norm) &&
      !/\busing index\b/.test(norm)
        ? 'CREATE UNIQUE INDEX CONCURRENTLY first, then ADD CONSTRAINT ... USING INDEX.'
        : null,
  },
  {
    id: 'fk-on-delete-explicit',
    describe: 'Foreign keys must state ON DELETE deliberately',
    check(norm) {
      if (!/^(?:create table|alter table)/.test(norm)) return null;
      // Every REFERENCES clause needs an ON DELETE inside the same column/constraint definition.
      const clauses = norm.split(/\breferences\b/).slice(1);
      const missing = clauses.some((c) => !/^[^,]*?\bon delete\b/.test(c.replace(/\([^)]*\)/, '')));
      return missing
        ? 'Add an explicit ON DELETE (CASCADE | RESTRICT | SET NULL | NO ACTION).'
        : null;
    },
  },
  {
    id: 'destructive',
    describe:
      'Destructive changes belong to the contract phase, in a later release than the code that stops using the old shape',
    check: (norm, ctx) => {
      if (/^drop table\b/.test(norm) || /^drop schema\b/.test(norm) || /^truncate\b/.test(norm))
        return 'Dropping/truncating is a contract-phase change: ship it in a later release, with "-- sold:allow destructive: <reason>".';
      if (onExistingTable(norm, ctx) && /\bdrop (?:column|constraint)\b/.test(norm))
        return 'Dropping a column/constraint breaks version N-1 during rollback. Ship it in a later release, with "-- sold:allow destructive: <reason>".';
      if (onExistingTable(norm, ctx) && /\brename\b/.test(norm))
        return 'Renames break version N-1. Add the new name, dual-write, and drop the old one in a later release.';
      return null;
    },
  },
  {
    id: 'blocking-command',
    describe: 'Commands that take long ACCESS EXCLUSIVE locks',
    check: (norm) => {
      if (/^lock table\b/.test(norm)) return 'LOCK TABLE blocks all traffic.';
      if (/^vacuum full\b/.test(norm) || /^cluster\b/.test(norm))
        return 'Rewrites the table under an exclusive lock.';
      if (/^reindex\b/.test(norm) && !/\bconcurrently\b/.test(norm))
        return 'Use REINDEX ... CONCURRENTLY.';
      if (/^refresh materialized view\b/.test(norm) && !/\bconcurrently\b/.test(norm))
        return 'Use REFRESH MATERIALIZED VIEW CONCURRENTLY.';
      return null;
    },
  },
];

export interface LintOptions {
  /** Treat the file as `-- sold:no-transaction`. */
  noTransaction: boolean;
}

const CREATE_TABLE = new RegExp(
  String.raw`^create (?:unlogged )?table (?:if not exists )?(${IDENT})`,
);

export function lintStatements(statements: Statement[], opts: LintOptions): Finding[] {
  const findings: Finding[] = [];
  const ctx: RuleContext = { newTables: new Set(), noTransaction: opts.noTransaction };

  for (const st of statements) {
    const norm = normalize(st.text);
    const created = tableOf(norm, CREATE_TABLE);
    if (created) ctx.newTables.add(created);

    const allowed = new Map<string, string>();
    for (const comment of st.leadingComments) {
      const m = /^sold:allow\s+([a-z-]+)\s*:\s*(\S.*)$/.exec(comment);
      if (m?.[1] && m[2]) allowed.set(m[1], m[2]);
      else if (/^sold:allow\b/.test(comment)) {
        findings.push({
          rule: 'allow-needs-reason',
          message:
            'A "-- sold:allow <rule>: <reason>" annotation must name a rule and give a reason.',
          line: st.line,
          statement: st.text.slice(0, 80),
        });
      }
    }

    for (const rule of rules) {
      if (allowed.has(rule.id)) continue;
      const message = rule.check(norm, ctx);
      if (message)
        findings.push({
          rule: rule.id,
          message,
          line: st.line,
          statement: st.text.replace(/\s+/g, ' ').slice(0, 80),
        });
    }

    if (
      !opts.noTransaction &&
      /^create (?:unique )?index concurrently\b/.test(norm) &&
      !allowed.has('concurrent-in-transaction')
    ) {
      findings.push({
        rule: 'concurrent-in-transaction',
        message:
          'CONCURRENTLY cannot run inside a transaction: put "-- sold:no-transaction" at the top of the file.',
        line: st.line,
        statement: st.text.slice(0, 80),
      });
    }
  }
  return findings;
}
