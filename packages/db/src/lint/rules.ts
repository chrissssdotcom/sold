import {
  arr,
  functionCalls,
  names,
  obj,
  qualified,
  relation,
  str,
  tableKey,
  unwrap,
  type Node,
} from './ast';
import type { ParsedStatement } from './parser';

export interface Finding {
  rule: string;
  message: string;
  line: number;
  statement: string;
}

export interface LintContext {
  /** File declared `-- sold:no-transaction`. */
  noTransaction: boolean;
  /** Full source, needed to read constraint text (explicit ON DELETE). */
  source: string;
}

export interface RuleDoc {
  id: string;
  describe: string;
}

/** Every rule id with a one-line description (for `describeRules()` and docs). */
export const rules: RuleDoc[] = [
  {
    id: 'index-not-concurrent',
    describe:
      'CREATE INDEX on an existing table must use CONCURRENTLY (a plain build blocks writes)',
  },
  { id: 'drop-index-not-concurrent', describe: 'DROP INDEX must use CONCURRENTLY' },
  {
    id: 'concurrent-if-not-exists',
    describe: 'Concurrent index builds must be idempotent (IF NOT EXISTS)',
  },
  {
    id: 'concurrent-in-transaction',
    describe: 'CONCURRENTLY cannot run in a transaction: use "-- sold:no-transaction"',
  },
  {
    id: 'no-transaction-needs-breakpoints',
    describe:
      'Statements in a no-transaction file must be separated by "--> statement-breakpoint" lines',
  },
  {
    id: 'add-column-not-null-no-default',
    describe: 'ADD COLUMN ... NOT NULL without DEFAULT fails on populated tables',
  },
  {
    id: 'add-column-volatile-default',
    describe: 'ADD COLUMN with a volatile or unknown-volatility DEFAULT rewrites the table',
  },
  {
    id: 'add-column-rewrite',
    describe: 'ADD COLUMN serial / identity / GENERATED STORED rewrites the table',
  },
  {
    id: 'add-column-constraint',
    describe:
      'Inline CHECK / REFERENCES / EXCLUDE on ADD COLUMN validates under lock: add it NOT VALID afterwards',
  },
  { id: 'alter-column-type', describe: 'ALTER COLUMN TYPE usually rewrites the table' },
  { id: 'set-not-null', describe: 'SET NOT NULL scans the table under an ACCESS EXCLUSIVE lock' },
  {
    id: 'add-constraint-not-valid',
    describe:
      'FOREIGN KEY / CHECK constraints on existing tables must be added NOT VALID and validated separately',
  },
  {
    id: 'add-unique-or-pk',
    describe: 'ADD UNIQUE / PRIMARY KEY builds an index under lock: use USING INDEX',
  },
  { id: 'add-exclusion', describe: 'ADD EXCLUDE builds an index under lock' },
  { id: 'fk-on-delete-explicit', describe: 'Foreign keys must state ON DELETE deliberately' },
  {
    id: 'partition-change',
    describe: 'ATTACH/DETACH PARTITION takes heavy locks and validates rows: do it deliberately',
  },
  {
    id: 'destructive',
    describe: 'Destructive changes belong to the contract phase, in a later release',
  },
  {
    id: 'unbounded-dml',
    describe: 'UPDATE/DELETE without WHERE on an existing table: batch backfills in a job',
  },
  {
    id: 'dynamic-sql',
    describe:
      'DO / EXECUTE run SQL the linter cannot see: requires an allow annotation with a reason',
  },
  {
    id: 'blocking-command',
    describe:
      'Commands that take long ACCESS EXCLUSIVE locks (LOCK, VACUUM FULL, CLUSTER, REINDEX, REFRESH MV)',
  },
  { id: 'syntax-error', describe: 'The file must parse as PostgreSQL' },
  {
    id: 'allow-needs-reason',
    describe: '"-- sold:allow <rule>: <reason>" needs a rule and a reason',
  },
];

/** Functions with immutable/stable volatility that are safe in ADD COLUMN DEFAULT (no rewrite since PostgreSQL 11). */
const SAFE_DEFAULT_FUNCTIONS = new Set([
  'now',
  'statement_timestamp',
  'transaction_timestamp',
  'current_setting',
  'lower',
  'upper',
  'concat',
  'length',
  'abs',
  'jsonb_build_object',
  'jsonb_build_array',
  'json_build_object',
  'json_build_array',
  'make_interval',
  'date_trunc',
  'to_timestamp',
  'array_fill',
  'btrim',
  'trim',
  'md5',
  'jsonb_strip_nulls',
]);
const SERIAL_TYPES = new Set([
  'serial',
  'serial2',
  'serial4',
  'serial8',
  'smallserial',
  'bigserial',
]);

const NON_TABLE_DROPS = new Set([
  'OBJECT_TABLE',
  'OBJECT_VIEW',
  'OBJECT_MATVIEW',
  'OBJECT_FOREIGN_TABLE',
]);
const DESTRUCTIVE_DROPS = new Set([
  'OBJECT_TABLE',
  'OBJECT_VIEW',
  'OBJECT_MATVIEW',
  'OBJECT_FOREIGN_TABLE',
  'OBJECT_SCHEMA',
  'OBJECT_FUNCTION',
  'OBJECT_PROCEDURE',
  'OBJECT_ROUTINE',
  'OBJECT_TYPE',
  'OBJECT_DOMAIN',
  'OBJECT_SEQUENCE',
  'OBJECT_EXTENSION',
  'OBJECT_TABLESPACE',
  'OBJECT_PUBLICATION',
]);
const DESTRUCTIVE_RENAMES = new Set([
  'OBJECT_TABLE',
  'OBJECT_COLUMN',
  'OBJECT_VIEW',
  'OBJECT_MATVIEW',
  'OBJECT_SCHEMA',
  'OBJECT_FUNCTION',
  'OBJECT_TYPE',
  'OBJECT_SEQUENCE',
  'OBJECT_ATTRIBUTE',
  'OBJECT_DOMAIN',
]);

/** Text of a constraint definition: from its `location` to the next top-level `,` or closing `)`. */
export function constraintText(source: string, location: number | undefined): string {
  if (location === undefined) return '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = location; i < source.length; i++) {
    const c = source[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return source.slice(location, i);
      depth--;
    } else if (c === ',' && depth === 0) return source.slice(location, i);
    else if (c === ';' && depth === 0) return source.slice(location, i);
  }
  return source.slice(location);
}

interface Emit {
  (rule: string, message: string): void;
}

export function lintStatements(
  statements: readonly ParsedStatement[],
  ctx: LintContext,
): Finding[] {
  const findings: Finding[] = [];
  /** Tables/matviews created earlier in this same migration: brand-new objects cannot be contended. */
  const created = new Set<string>();
  const isNew = (r: { schema?: string | undefined; name: string } | undefined) =>
    r !== undefined && created.has(tableKey(r));

  for (const st of statements) {
    for (const bad of st.badAnnotations) {
      findings.push({
        rule: 'allow-needs-reason',
        message: `"${bad}" must be "-- sold:allow <rule>: <reason>".`,
        line: st.line,
        statement: st.text.slice(0, 80),
      });
    }
    const emit: Emit = (rule, message) => {
      if (st.allowed.has(rule)) return;
      findings.push({
        rule,
        message,
        line: st.line,
        statement: st.text.replace(/\s+/g, ' ').slice(0, 80),
      });
    };
    lintOne(st, ctx, emit, created, isNew);
  }

  if (ctx.noTransaction) {
    // Each no-transaction statement runs on its own, so the file must be split at breakpoint lines.
    const chunks = ctx.source
      .split(/^[ \t]*--> statement-breakpoint[ \t]*$/m)
      .filter((c) => c.replace(/--[^\n]*/g, '').trim().length > 0);
    if (statements.length > 1 && chunks.length < statements.length) {
      const first = statements[1] as ParsedStatement;
      findings.push({
        rule: 'no-transaction-needs-breakpoints',
        message:
          'A "-- sold:no-transaction" file runs one statement per "--> statement-breakpoint" chunk; separate every statement with such a line.',
        line: first.line,
        statement: first.text.slice(0, 80),
      });
    }
  }
  return findings;
}

function lintOne(
  st: ParsedStatement,
  ctx: LintContext,
  emit: Emit,
  created: Set<string>,
  isNew: (r: { schema?: string | undefined; name: string } | undefined) => boolean,
): void {
  const n = st.node;
  switch (st.kind) {
    case 'CreateStmt': {
      const rel = relation(n.relation);
      if (rel) created.add(tableKey(rel));
      for (const el of arr(n.tableElts)) {
        const u = unwrap(el);
        if (u?.kind === 'ColumnDef')
          for (const c of arr(u.node.constraints)) fkCheck(unwrap(c)?.node, ctx, emit);
        else if (u?.kind === 'Constraint') fkCheck(u.node, ctx, emit);
      }
      return;
    }
    case 'CreateTableAsStmt':
    case 'ViewStmt': {
      const rel = st.kind === 'ViewStmt' ? relation(n.view) : relation(obj(n.into)?.rel);
      if (rel) created.add(tableKey(rel));
      return;
    }
    case 'IndexStmt': {
      const rel = relation(n.relation);
      const fresh = isNew(rel);
      const concurrent = n.concurrent === true;
      if (!concurrent && !fresh)
        emit(
          'index-not-concurrent',
          `Use CREATE INDEX CONCURRENTLY IF NOT EXISTS on "${rel?.name}" in a "-- sold:no-transaction" migration.`,
        );
      if (concurrent && n.if_not_exists !== true)
        emit('concurrent-if-not-exists', 'Add IF NOT EXISTS so a rerun after failure is safe.');
      if (concurrent && !ctx.noTransaction)
        emit(
          'concurrent-in-transaction',
          'CONCURRENTLY cannot run inside a transaction: put "-- sold:no-transaction" at the top of the file.',
        );
      return;
    }
    case 'DropStmt': {
      const type = str(n.removeType) ?? '';
      const concurrent = n.concurrent === true;
      if (type === 'OBJECT_INDEX') {
        if (!concurrent)
          emit('drop-index-not-concurrent', 'Use DROP INDEX CONCURRENTLY IF EXISTS.');
        else if (!ctx.noTransaction)
          emit(
            'concurrent-in-transaction',
            'DROP INDEX CONCURRENTLY cannot run inside a transaction: put "-- sold:no-transaction" at the top of the file.',
          );
        return;
      }
      if (DESTRUCTIVE_DROPS.has(type)) {
        const targets = arr(n.objects).map((o) =>
          qualified(obj(o)?.List ? obj(obj(o)?.List)?.items : o),
        );
        const allNew =
          NON_TABLE_DROPS.has(type) && targets.length > 0 && targets.every((t) => isNew(t));
        if (!allNew)
          emit(
            'destructive',
            'Dropping is a contract-phase change: ship it in a later release than the code that stops using it, with "-- sold:allow destructive: <reason>".',
          );
      }
      return;
    }
    case 'TruncateStmt': {
      const rels = arr(n.relations).map((r) => relation(unwrap(r)?.node));
      if (!rels.every((r) => isNew(r)))
        emit(
          'destructive',
          'TRUNCATE is destructive: with "-- sold:allow destructive: <reason>" only.',
        );
      return;
    }
    case 'RenameStmt': {
      const type = str(n.renameType) ?? '';
      if (DESTRUCTIVE_RENAMES.has(type) && !isNew(relation(n.relation))) {
        emit(
          'destructive',
          'Renames break version N-1. Add the new name, dual-write, and drop the old one in a later release.',
        );
      }
      return;
    }
    case 'AlterTableStmt': {
      const rel = relation(n.relation);
      if (isNew(rel)) return;
      for (const c of arr(n.cmds)) {
        const cmd = unwrap(c)?.node;
        if (cmd) alterCmd(cmd, ctx, emit);
      }
      return;
    }
    case 'UpdateStmt':
    case 'DeleteStmt': {
      if (!n.whereClause && !isNew(relation(n.relation))) {
        emit(
          'unbounded-dml',
          `${st.kind === 'UpdateStmt' ? 'UPDATE' : 'DELETE'} without WHERE touches every row: run backfills in batches from a job, not in a migration.`,
        );
      }
      return;
    }
    case 'DoStmt':
    case 'ExecuteStmt':
      emit(
        'dynamic-sql',
        'DO/EXECUTE run SQL the linter cannot analyse. Add "-- sold:allow dynamic-sql: <what it does and why it is safe>".',
      );
      return;
    case 'LockStmt':
      emit('blocking-command', 'LOCK TABLE blocks all traffic.');
      return;
    case 'ClusterStmt':
      emit('blocking-command', 'CLUSTER rewrites the table under an exclusive lock.');
      return;
    case 'VacuumStmt': {
      const full = arr(n.options).some(
        (o) => str(obj(unwrap(o)?.node)?.defname)?.toLowerCase() === 'full',
      );
      if (full) emit('blocking-command', 'VACUUM FULL rewrites the table under an exclusive lock.');
      return;
    }
    case 'ReindexStmt': {
      const concurrently = arr(n.params).some(
        (p) => str(unwrap(p)?.node.defname)?.toLowerCase() === 'concurrently',
      );
      if (!concurrently) emit('blocking-command', 'Use REINDEX ... CONCURRENTLY.');
      else if (!ctx.noTransaction)
        emit('concurrent-in-transaction', 'REINDEX CONCURRENTLY cannot run inside a transaction.');
      return;
    }
    case 'RefreshMatViewStmt':
      if (n.concurrent !== true && n.skipData !== true)
        emit('blocking-command', 'Use REFRESH MATERIALIZED VIEW CONCURRENTLY (or WITH NO DATA).');
      return;
    default:
  }
}

function fkCheck(constraint: Node | undefined, ctx: LintContext, emit: Emit): void {
  if (!constraint || constraint.contype !== 'CONSTR_FOREIGN') return;
  const text = constraintText(
    ctx.source,
    typeof constraint.location === 'number' ? constraint.location : undefined,
  );
  if (!/\bon\s+delete\b/i.test(text))
    emit(
      'fk-on-delete-explicit',
      'Add an explicit ON DELETE (CASCADE | RESTRICT | SET NULL | NO ACTION).',
    );
}

function alterCmd(cmd: Node, ctx: LintContext, emit: Emit): void {
  const type = str(cmd.subtype) ?? '';
  const def = obj(cmd.def);
  switch (type) {
    case 'AT_AddColumn': {
      const col = obj(def?.ColumnDef);
      if (!col) return;
      const typeName = names(obj(col.typeName)?.names).at(-1)?.toLowerCase() ?? '';
      if (SERIAL_TYPES.has(typeName))
        emit(
          'add-column-rewrite',
          'serial creates a sequence default: add the column plain, then attach a sequence default separately.',
        );
      let notNull = col.is_not_null === true;
      let hasDefault = false;
      for (const c of arr(col.constraints)) {
        const k = unwrap(c)?.node;
        if (!k) continue;
        const ct = str(k.contype);
        if (ct === 'CONSTR_NOTNULL') notNull = true;
        else if (ct === 'CONSTR_DEFAULT') {
          hasDefault = true;
          const bad = functionCalls(k.raw_expr).filter((f) => !SAFE_DEFAULT_FUNCTIONS.has(f));
          if (bad.length > 0)
            emit(
              'add-column-volatile-default',
              `DEFAULT calls ${bad.map((b) => `${b}()`).join(', ')}: volatile or unknown volatility forces a table rewrite. Add the column without a default and backfill in batches.`,
            );
        } else if (ct === 'CONSTR_GENERATED' || ct === 'CONSTR_IDENTITY')
          emit('add-column-rewrite', 'GENERATED / IDENTITY columns rewrite the table.');
        else if (ct === 'CONSTR_CHECK' || ct === 'CONSTR_FOREIGN' || ct === 'CONSTR_EXCLUSION') {
          emit(
            'add-column-constraint',
            'Add the column, then the constraint NOT VALID, then VALIDATE CONSTRAINT in a separate statement.',
          );
          if (ct === 'CONSTR_FOREIGN') fkCheck(k, ctx, emit);
        } else if (ct === 'CONSTR_UNIQUE' || ct === 'CONSTR_PRIMARY')
          emit(
            'add-unique-or-pk',
            'CREATE UNIQUE INDEX CONCURRENTLY first, then ADD CONSTRAINT ... USING INDEX.',
          );
      }
      if (notNull && !hasDefault)
        emit(
          'add-column-not-null-no-default',
          'Add the column nullable (or with a constant DEFAULT), backfill in batches, then add CHECK (col IS NOT NULL) NOT VALID / VALIDATE.',
        );
      return;
    }
    case 'AT_AddConstraint': {
      const k = obj(def?.Constraint);
      if (!k) return;
      const ct = str(k.contype);
      if (ct === 'CONSTR_CHECK' && k.skip_validation !== true)
        emit(
          'add-constraint-not-valid',
          'Add the constraint NOT VALID, then ALTER TABLE ... VALIDATE CONSTRAINT in a separate statement.',
        );
      else if (ct === 'CONSTR_FOREIGN') {
        if (k.skip_validation !== true)
          emit(
            'add-constraint-not-valid',
            'Add the constraint NOT VALID, then ALTER TABLE ... VALIDATE CONSTRAINT in a separate statement.',
          );
        fkCheck(k, ctx, emit);
      } else if ((ct === 'CONSTR_UNIQUE' || ct === 'CONSTR_PRIMARY') && !k.indexname)
        emit(
          'add-unique-or-pk',
          'CREATE UNIQUE INDEX CONCURRENTLY first, then ADD CONSTRAINT ... USING INDEX.',
        );
      else if (ct === 'CONSTR_EXCLUSION')
        emit('add-exclusion', 'EXCLUDE builds an index under an exclusive lock.');
      else if (ct === 'CONSTR_NOTNULL')
        emit(
          'set-not-null',
          'Add CHECK (col IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL.',
        );
      return;
    }
    case 'AT_SetNotNull':
      emit(
        'set-not-null',
        'Add CHECK (col IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL (PostgreSQL 12+ skips the scan).',
      );
      return;
    case 'AT_AlterColumnType':
      emit(
        'alter-column-type',
        'Use expand/contract: add a new column, dual-write, backfill in batches, switch reads, drop the old column in a later release.',
      );
      return;
    case 'AT_DropColumn':
    case 'AT_DropConstraint':
      emit(
        'destructive',
        'Dropping a column/constraint breaks version N-1 during rollback. Ship it in a later release, with "-- sold:allow destructive: <reason>".',
      );
      return;
    case 'AT_SetLogged':
    case 'AT_SetUnLogged':
    case 'AT_SetTableSpace':
      emit('blocking-command', 'Rewrites the table under an exclusive lock.');
      return;
    case 'AT_AddIdentity':
      emit('add-column-rewrite', 'IDENTITY rewrites the table.');
      return;
    case 'AT_AttachPartition':
    case 'AT_DetachPartition':
    case 'AT_DetachPartitionFinalize':
      emit(
        'partition-change',
        'ATTACH/DETACH PARTITION takes heavy locks and validates rows. Do it deliberately, with "-- sold:allow partition-change: <reason>".',
      );
      return;
    default:
  }
}
