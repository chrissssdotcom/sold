import {
  BASE_READ_TABLES,
  BASE_REFERENCEABLE_TABLES,
  BASE_TABLE_FUNCTIONS,
  BASE_TRIGGER_FUNCTIONS,
  extensionPrefix,
  ownsObject,
} from '../extension-access';
import { arr, names, obj, qualified, str, unwrap, type Node } from './ast';
import { parseMigration, type ParsedStatement } from './parser';
import { lintStatements, type Finding, type LintContext } from './rules';

export { extensionPrefix } from '../extension-access';

/**
 * Extension migrations are checked against an ALLOWLIST (ADR-0004). An extension migration may only:
 *
 *  - create and change tables, indexes, sequences, views, SQL functions, types and triggers whose names are in the
 *    extension's own namespace (`ext_<name>_*`, public schema, exact owned-name check);
 *  - INSERT/UPDATE/DELETE/TRUNCATE rows of its own tables;
 *  - SELECT from its own tables and from the small documented Base read allowlist (`BASE_READ_TABLES`);
 *  - call a short list of side-effect-free built-in functions.
 *
 * Everything else is rejected by default, including every statement kind this file does not list, so a new
 * PostgreSQL feature is denied until someone decides it is safe. The AST is walked recursively (writable CTEs,
 * sub-selects, MERGE, function bodies), because "the statement looks like a SELECT" proved to be a bypass.
 *
 * These rules are NOT waivable: `-- sold:allow` is honoured only for the ordinary online-safety rules that Base's
 * own migrations use (lock/rewrite rules). It never disables an `extension-*` rule.
 */

const FORBIDDEN_MESSAGES: Record<string, string> = {
  CreateSchemaStmt: 'Extensions may not create or change schemas.',
  CreateExtensionStmt: 'Extensions may not install database extensions; ask Base to provide it.',
  AlterExtensionStmt: 'Extensions may not change database extensions.',
  GrantStmt: 'Extensions may not change privileges.',
  GrantRoleStmt: 'Extensions may not change privileges.',
  AlterDefaultPrivilegesStmt: 'Extensions may not change privileges.',
  CreateRoleStmt: 'Extensions may not manage roles.',
  AlterRoleStmt: 'Extensions may not manage roles.',
  AlterRoleSetStmt: 'Extensions may not manage roles.',
  DropRoleStmt: 'Extensions may not manage roles.',
  ReassignOwnedStmt: 'Extensions may not manage roles or ownership.',
  DropOwnedStmt: 'Extensions may not manage roles or ownership.',
  AlterOwnerStmt: 'Extensions may not change ownership.',
  AlterDatabaseStmt: 'Extensions may not change database settings.',
  AlterDatabaseSetStmt: 'Extensions may not change database settings.',
  AlterSystemStmt: 'Extensions may not change server settings.',
  VariableSetStmt:
    'Extensions may not change session settings (SET / RESET, LOCAL or not); the runner sets migration timeouts.',
  TransactionStmt:
    'Extensions may not control transactions (BEGIN / COMMIT / ROLLBACK / SAVEPOINT): the runner wraps each file in one transaction, and a COMMIT inside it leaves a half-applied migration.',
  CopyStmt: 'COPY is not allowed in extension migrations.',
  DoStmt: 'DO blocks are not allowed in extension migrations.',
  CallStmt: 'CALL is not allowed in extension migrations.',
  ListenStmt: 'LISTEN/NOTIFY are not allowed in extension migrations.',
  NotifyStmt: 'LISTEN/NOTIFY are not allowed in extension migrations.',
  VacuumStmt: 'Maintenance commands are not allowed in extension migrations.',
  ClusterStmt: 'Maintenance commands are not allowed in extension migrations.',
  ReindexStmt: 'Maintenance commands are not allowed in extension migrations.',
  CreateFdwStmt: 'Extensions may not create foreign data wrappers.',
  CreateForeignServerStmt: 'Extensions may not create foreign servers.',
  CreatePolicyStmt: 'Extensions may not create row-level security policies.',
  AlterPolicyStmt: 'Extensions may not change row-level security policies.',
  CreateEventTrigStmt: 'Extensions may not create event triggers.',
  RuleStmt: 'Extensions may not create rules (they rewrite queries on other tables).',
  CreatePublicationStmt: 'Extensions may not create publications.',
  AlterPublicationStmt: 'Extensions may not change publications.',
  CreateSubscriptionStmt: 'Extensions may not create subscriptions.',
  LoadStmt: 'LOAD is not allowed in extension migrations.',
  PrepareStmt: 'PREPARE / EXECUTE are not allowed in extension migrations.',
  ExecuteStmt: 'PREPARE / EXECUTE are not allowed in extension migrations.',
  SecLabelStmt: 'Extensions may not set security labels.',
  LockStmt: 'LOCK is not allowed in extension migrations.',
  AlterObjectSchemaStmt: 'Extensions may not move objects between schemas.',
  AlterFunctionStmt: 'ALTER FUNCTION is not allowed: replace the function with CREATE OR REPLACE.',
  CreateRangeStmt: 'Range types are not allowed in extension migrations.',
  CreatePLangStmt: 'Extensions may not create procedural languages.',
  DefineStmt: 'Extensions may not create aggregates, operators or other low-level objects.',
  CreateCastStmt: 'Extensions may not create casts.',
  CreateStatsStmt: 'Extended statistics are not allowed in extension migrations.',
  DiscardStmt: 'DISCARD is not allowed in extension migrations.',
  CheckPointStmt: 'Maintenance commands are not allowed in extension migrations.',
};

/** Statement kinds an extension migration may contain, at the top level. */
const MIGRATION_KINDS = new Set([
  'CreateStmt',
  'AlterTableStmt',
  'IndexStmt',
  'ViewStmt',
  'CreateTableAsStmt',
  'RefreshMatViewStmt',
  'CreateFunctionStmt',
  'CreateSeqStmt',
  'AlterSeqStmt',
  'CompositeTypeStmt',
  'CreateEnumStmt',
  'AlterEnumStmt',
  'CreateDomainStmt',
  'CreateTrigStmt',
  'DropStmt',
  'RenameStmt',
  'CommentStmt',
  'TruncateStmt',
  'InsertStmt',
  'UpdateStmt',
  'DeleteStmt',
  'MergeStmt',
  'SelectStmt',
]);
/** What a SQL-language function body may contain. */
const BODY_KINDS = new Set(['SelectStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);

const ALTER_TABLE_SUBTYPES = new Set([
  'AT_AddColumn',
  'AT_DropColumn',
  'AT_ColumnDefault',
  'AT_DropNotNull',
  'AT_SetNotNull',
  'AT_AddConstraint',
  'AT_DropConstraint',
  'AT_ValidateConstraint',
  'AT_AlterColumnType',
  'AT_SetStatistics',
  'AT_SetRelOptions',
  'AT_ResetRelOptions',
  'AT_AddIdentity',
  'AT_SetIdentity',
  'AT_DropIdentity',
  'AT_DropExpression',
  'AT_SetExpression',
]);
/** Sub-commands that name another table: allowed only when it is the extension's own. */
const ALTER_TABLE_RELATED = new Set([
  'AT_AddInherit',
  'AT_DropInherit',
  'AT_AttachPartition',
  'AT_DetachPartition',
]);
const ALTER_TABLE_OBJTYPES = new Set([
  'OBJECT_TABLE',
  'OBJECT_INDEX',
  'OBJECT_VIEW',
  'OBJECT_MATVIEW',
  'OBJECT_SEQUENCE',
]);
const RENAME_OBJECTS = new Set([
  'OBJECT_TABLE',
  'OBJECT_INDEX',
  'OBJECT_VIEW',
  'OBJECT_MATVIEW',
  'OBJECT_SEQUENCE',
]);
const RENAME_MEMBERS = new Set(['OBJECT_COLUMN', 'OBJECT_TABCONSTRAINT']);
const DROP_RELATIONS = new Set([
  'OBJECT_TABLE',
  'OBJECT_INDEX',
  'OBJECT_VIEW',
  'OBJECT_MATVIEW',
  'OBJECT_SEQUENCE',
]);
const DROP_FUNCTIONS = new Set(['OBJECT_FUNCTION', 'OBJECT_PROCEDURE', 'OBJECT_ROUTINE']);
const DROP_TYPES = new Set(['OBJECT_TYPE', 'OBJECT_DOMAIN']);

/** Built-in functions that are pure or read the clock: safe in defaults, checks, indexes, views and data statements. */
const SAFE_FUNCTIONS = new Set([
  'now',
  'clock_timestamp',
  'statement_timestamp',
  'transaction_timestamp',
  'lower',
  'upper',
  'initcap',
  'length',
  'char_length',
  'character_length',
  'octet_length',
  'btrim',
  'ltrim',
  'rtrim',
  'trim',
  'substr',
  'substring',
  'left',
  'right',
  'lpad',
  'rpad',
  'replace',
  'translate',
  'concat',
  'concat_ws',
  'split_part',
  'position',
  'overlay',
  'starts_with',
  'md5',
  'encode',
  'decode',
  'to_char',
  'to_number',
  'to_date',
  'to_timestamp',
  'date_trunc',
  'date_part',
  'date_bin',
  'extract',
  'age',
  'timezone',
  'make_date',
  'make_interval',
  'make_timestamptz',
  'abs',
  'ceil',
  'ceiling',
  'floor',
  'round',
  'trunc',
  'mod',
  'power',
  'sqrt',
  'sign',
  'gen_random_uuid',
  'sold_uuid_v7',
  'to_json',
  'to_jsonb',
  'json_build_object',
  'json_build_array',
  'jsonb_build_object',
  'jsonb_build_array',
  'jsonb_set',
  'jsonb_strip_nulls',
  'jsonb_typeof',
  'jsonb_array_length',
  'jsonb_agg',
  'jsonb_object_agg',
  'array_length',
  'array_agg',
  'array_fill',
  'array_to_string',
  'string_to_array',
  'cardinality',
  'unnest',
  'generate_series',
  'regexp_replace',
  'regexp_match',
  'count',
  'sum',
  'min',
  'max',
  'avg',
  'bool_and',
  'bool_or',
  'string_agg',
  'row_number',
  'rank',
  'dense_rank',
  'lag',
  'lead',
  'first_value',
  'last_value',
  'coalesce',
  'nullif',
  'greatest',
  'least',
]);
/** `nextval('seq')`-style functions: allowed only when the literal names one of the extension's own objects. */
const SEQUENCE_FUNCTIONS = new Set(['nextval', 'currval', 'setval']);

interface Ctx {
  extension: string;
  prefix: string;
  others: readonly string[];
  report(rule: string, message: string): void;
  /** Nodes already checked as a specific target: the generic walk must not treat them as reads. */
  handled: Set<object>;
  /** CTE names visible in the statement (unqualified references to them are not tables). */
  ctes: Set<string>;
  /** Relations read by the statement (for the view rule). */
  reads: Set<string>;
  /** Function-body mode: nothing but DML/SELECT is allowed. */
  body: boolean;
}

const own = (c: Ctx, name: string, schema: string | undefined): boolean =>
  (schema === undefined || schema === 'public') && ownsObject(c.extension, name, c.others);

const isBaseReadable = (name: string, schema: string | undefined): boolean =>
  (schema === undefined || schema === 'public') &&
  (BASE_READ_TABLES as readonly string[]).includes(name);

/** A `{relname, schemaname}` node (RangeVar without its wrapper). */
function rel(v: unknown): { name: string; schema: string | undefined; temp: boolean } | undefined {
  const r = obj(v);
  const name = str(r?.relname);
  return r && name
    ? { name, schema: str(r.schemaname), temp: r.relpersistence === 't' }
    : undefined;
}

function needOwnRelation(
  c: Ctx,
  node: unknown,
  what: string,
  mode: 'create' | 'alter' | 'write',
): void {
  const r = rel(node);
  if (!r) return;
  c.handled.add(node as object);
  const label = r.schema ? `${r.schema}.${r.name}` : r.name;
  if (r.schema !== undefined && r.schema !== 'public') {
    c.report(
      'extension-namespace',
      `${what} "${label}" is in schema "${r.schema}": extensions may only use the public schema.`,
    );
  } else if (!own(c, r.name, r.schema)) {
    c.report(
      'extension-namespace',
      mode === 'create'
        ? `${what} "${r.name}" must be named ${c.prefix}* (letters, digits and underscores only).`
        : what === 'table'
          ? `Extensions must never alter Base tables: "${r.name}" is not one of this extension's tables (${c.prefix}*). Use a side table with a foreign key, or the metadata jsonb column.`
          : `${what} "${r.name}" is not one of this extension's objects (${c.prefix}*).`,
    );
  }
  if (r.temp)
    c.report('extension-forbidden', 'Temporary tables are not allowed in extension migrations.');
}

function needOwnName(
  c: Ctx,
  list: unknown,
  what: string,
  mode: 'create' | 'alter' = 'alter',
): void {
  const q = qualified(list);
  if (!q) return;
  if (q.schema !== undefined && q.schema !== 'public')
    c.report(
      'extension-namespace',
      `${what} "${q.schema}.${q.name}" is in schema "${q.schema}": extensions may only use the public schema.`,
    );
  else if (!own(c, q.name, q.schema))
    c.report(
      'extension-namespace',
      mode === 'create'
        ? `${what} "${q.name}" must be named ${c.prefix}* (letters, digits and underscores only).`
        : `${what} "${q.name}" is not one of this extension's objects (${c.prefix}*).`,
    );
}

function needOwnNameParts(c: Ctx, parts: string[], what: string): void {
  const name = parts.at(-1);
  if (!name) return;
  const schema = parts.length > 1 ? parts.at(-2) : undefined;
  if (schema !== undefined && schema !== 'public')
    c.report(
      'extension-namespace',
      `${what} "${schema}.${name}" is in schema "${schema}": extensions may only use the public schema.`,
    );
  else if (!own(c, name, schema))
    c.report(
      'extension-namespace',
      `${what} "${name}" is not one of this extension's objects (${c.prefix}*).`,
    );
}

/** The first argument of `nextval('x'::regclass)`: the object name in the literal, if it is one. */
function literalObjectName(arg: unknown): string[] | undefined {
  let v = obj(arg);
  const cast = obj(v?.TypeCast);
  if (cast) v = obj(cast.arg);
  const s = str(obj(obj(v?.A_Const)?.sval)?.sval);
  if (s === undefined) return undefined;
  // `'public.ext_a_seq'` or `'ext_a_seq'` (quoted identifiers are not supported: they fail the owned-name check).
  return s.split('.');
}

function checkFuncCall(c: Ctx, fc: Node): void {
  const parts = names(fc.funcname);
  const name = parts.at(-1);
  if (!name) return;
  const schema = parts.length > 1 ? parts.at(-2) : undefined;
  const label = parts.join('.');
  if ((schema === undefined || schema === 'public') && ownsObject(c.extension, name, c.others))
    return; // the extension's own (linted) SQL function
  const builtin = schema === undefined || schema === 'pg_catalog';
  if (builtin && SAFE_FUNCTIONS.has(name)) return;
  if (
    (schema === undefined || schema === 'pg_catalog' || schema === 'public') &&
    (SEQUENCE_FUNCTIONS.has(name) || (BASE_TABLE_FUNCTIONS as readonly string[]).includes(name))
  ) {
    const target = literalObjectName(arr(fc.args)[0]);
    if (target && needOwnLiteral(c, target)) return;
    c.report(
      'extension-forbidden',
      `${label}() may only be called with a literal naming one of this extension's own objects (${c.prefix}*), e.g. ${label}('${c.prefix}x'::regclass).`,
    );
    return;
  }
  c.report(
    'extension-forbidden',
    `function ${label}() is not on the allowlist for extension migrations (side effects, session state, file access and the like are refused).`,
  );
}

function needOwnLiteral(c: Ctx, parts: string[]): boolean {
  const name = parts.at(-1);
  const schema = parts.length > 1 ? parts.at(-2) : undefined;
  return name !== undefined && parts.length <= 2 && own(c, name, schema);
}

function checkForeignKey(c: Ctx, con: Node): void {
  const target = con.pktable;
  const r = rel(target);
  if (!r) return;
  c.handled.add(target as object);
  const ownTarget = own(c, r.name, r.schema);
  if (!ownTarget) {
    const ok =
      (r.schema === undefined || r.schema === 'public') &&
      BASE_REFERENCEABLE_TABLES.includes(r.name);
    if (!ok)
      c.report(
        'extension-namespace',
        `foreign key target "${r.name}" is neither this extension's table nor a Base table extensions may reference (${BASE_REFERENCEABLE_TABLES.join(', ')}).`,
      );
    else if (!['c', 'n', 'd'].includes(str(con.fk_del_action) ?? 'a'))
      c.report(
        'extension-base-fk',
        `a foreign key to Base table "${r.name}" must be ON DELETE CASCADE or SET NULL: RESTRICT / NO ACTION would let this extension block Base deletes.`,
      );
  }
}

/** Recursive walk over every node of a statement: function calls, relation reads, writable sub-statements, FKs. */
function walk(c: Ctx, v: unknown): void {
  if (Array.isArray(v)) {
    for (const e of v) walk(c, e);
    return;
  }
  const o = obj(v);
  if (!o) return;
  if (typeof o.relname === 'string' && !c.handled.has(o)) {
    const r = rel(o);
    if (r && !(r.schema === undefined && c.ctes.has(r.name))) {
      c.reads.add(r.name);
      if (!own(c, r.name, r.schema) && !isBaseReadable(r.name, r.schema)) {
        c.report(
          'extension-namespace',
          `"${r.schema ? `${r.schema}.` : ''}${r.name}" may not be read: extensions may read only their own tables and the Base read allowlist (${BASE_READ_TABLES.join(', ')}).`,
        );
      }
    }
  }
  for (const [k, val] of Object.entries(o)) {
    switch (k) {
      case 'FuncCall':
        checkFuncCall(c, obj(val) ?? {});
        break;
      case 'InsertStmt':
      case 'UpdateStmt':
      case 'DeleteStmt':
      case 'MergeStmt':
        needOwnRelation(c, obj(val)?.relation, 'table', 'write');
        break;
      case 'IntoClause':
        needOwnRelation(c, obj(val)?.rel, 'table', 'create');
        break;
      case 'LockingClause':
        c.report(
          'extension-forbidden',
          'SELECT ... FOR UPDATE/SHARE takes row locks and is not allowed in extension migrations.',
        );
        break;
      case 'Constraint':
        if (obj(val)?.contype === 'CONSTR_FOREIGN') checkForeignKey(c, obj(val) as Node);
        break;
      default:
    }
    walk(c, val);
  }
}

function collectCtes(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) for (const e of v) collectCtes(e, out);
  else if (obj(v))
    for (const [k, val] of Object.entries(v as Node)) {
      if (k === 'ctename' && typeof val === 'string') out.add(val);
      collectCtes(val, out);
    }
}

function defElems(list: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const d of arr(list)) {
    const n = obj(unwrap(d)?.node);
    const name = str(n?.defname);
    if (name) out.set(name, n?.arg);
  }
  return out;
}

const stringArg = (arg: unknown): string | undefined => str(obj(obj(arg)?.String)?.sval);

const boolArg = (arg: unknown): boolean | undefined => {
  const o = obj(arg);
  if (typeof obj(o?.Boolean)?.boolval === 'boolean') return obj(o?.Boolean)?.boolval as boolean;
  const s = str(obj(o?.String)?.sval);
  return s === undefined ? undefined : ['true', 'on', '1'].includes(s.toLowerCase());
};

async function checkStatement(st: ParsedStatement, c: Ctx): Promise<void> {
  const n = st.node;
  const allowed = c.body ? BODY_KINDS : MIGRATION_KINDS;
  if (!allowed.has(st.kind)) {
    c.report(
      'extension-forbidden',
      c.body && MIGRATION_KINDS.has(st.kind)
        ? `${st.kind} is not allowed inside a function body.`
        : (FORBIDDEN_MESSAGES[st.kind] ??
            `${st.kind} is not allowed in extension migrations (only tables, indexes, sequences, views, SQL functions, types and triggers in ${c.prefix}*, plus data changes to them).`),
    );
    return;
  }

  collectCtes(n, c.ctes);

  switch (st.kind) {
    case 'CreateStmt': {
      needOwnRelation(c, n.relation, 'table', 'create');
      for (const p of arr(n.inhRelations)) {
        const target = obj(p)?.RangeVar ?? p;
        needOwnRelation(c, target, 'table', 'alter');
      }
      if (str(n.tablespacename) || str(n.accessMethod))
        c.report(
          'extension-forbidden',
          'Custom tablespaces and access methods are not allowed in extension migrations.',
        );
      break;
    }
    case 'AlterTableStmt': {
      const objtype = str(n.objtype) ?? 'OBJECT_TABLE';
      if (!ALTER_TABLE_OBJTYPES.has(objtype))
        c.report('extension-forbidden', `ALTER ${objtype.replace('OBJECT_', '')} is not allowed.`);
      needOwnRelation(c, n.relation, objtype === 'OBJECT_TABLE' ? 'table' : 'object', 'alter');
      for (const cmd of arr(n.cmds)) {
        const cn = obj(unwrap(cmd)?.node);
        const sub = str(cn?.subtype) ?? '?';
        if (ALTER_TABLE_RELATED.has(sub)) {
          const def = obj(cn?.def);
          const target = obj(def?.RangeVar) ?? obj(obj(def?.PartitionCmd)?.name);
          needOwnRelation(c, target, 'table', 'alter');
        } else if (!ALTER_TABLE_SUBTYPES.has(sub)) {
          c.report(
            'extension-forbidden',
            `ALTER TABLE ... ${sub.replace('AT_', '')} is not allowed in extension migrations (ownership, triggers, row security, replica identity, tablespaces, logging and similar are Base's business).`,
          );
        }
      }
      break;
    }
    case 'RenameStmt': {
      const type = str(n.renameType) ?? '?';
      if (RENAME_OBJECTS.has(type)) {
        needOwnRelation(c, n.relation, type === 'OBJECT_TABLE' ? 'table' : 'object', 'alter');
        const newName = str(n.newname);
        if (newName && !own(c, newName, undefined))
          c.report(
            'extension-namespace',
            `cannot rename to "${newName}": the new name must be ${c.prefix}*.`,
          );
      } else if (RENAME_MEMBERS.has(type)) {
        needOwnRelation(c, n.relation, 'table', 'alter');
      } else {
        c.report('extension-forbidden', `RENAME of ${type.replace('OBJECT_', '')} is not allowed.`);
      }
      break;
    }
    case 'IndexStmt': {
      needOwnRelation(c, n.relation, 'table', 'alter');
      const idx = str(n.idxname);
      if (idx && !own(c, idx, undefined))
        c.report('extension-namespace', `index "${idx}" must be named ${c.prefix}*.`);
      if (str(n.tableSpace)) c.report('extension-forbidden', 'Custom tablespaces are not allowed.');
      break;
    }
    case 'ViewStmt': {
      needOwnRelation(c, n.view, 'view', 'create');
      const vc: Ctx = { ...c, reads: new Set() };
      walk(vc, n.query);
      const readsBase = [...vc.reads].some((r) => !own(c, r, undefined));
      if (readsBase && boolArg(defElems(n.options).get('security_invoker')) !== true)
        c.report(
          'extension-forbidden',
          "A view that reads Base tables must be created WITH (security_invoker = true): otherwise it runs with its owner's rights and would bypass the extension's database role.",
        );
      break;
    }
    case 'CreateTableAsStmt': {
      needOwnRelation(c, obj(n.into)?.rel, 'table', 'create');
      break;
    }
    case 'RefreshMatViewStmt':
      needOwnRelation(c, n.relation, 'materialized view', 'alter');
      break;
    case 'CreateFunctionStmt': {
      needOwnName(c, n.funcname, 'function', 'create');
      const opts = defElems(n.options);
      const lang = stringArg(opts.get('language'));
      if (lang !== 'sql')
        c.report(
          'extension-forbidden',
          `functions must be LANGUAGE sql (got ${lang ?? 'none'}): procedural code cannot be linted, so plpgsql, C and other languages are not allowed. Do the work in extension code (TypeScript) instead.`,
        );
      if (boolArg(opts.get('security')) === true)
        c.report('extension-forbidden', 'SECURITY DEFINER functions are not allowed.');
      if (opts.has('set')) c.report('extension-forbidden', 'Functions may not carry SET clauses.');
      if (boolArg(opts.get('leakproof')) === true)
        c.report('extension-forbidden', 'LEAKPROOF functions are not allowed.');
      const bodies = arr(obj(obj(opts.get('as'))?.List)?.items)
        .map((i) => stringArg(i))
        .filter((s): s is string => s !== undefined);
      if (lang === 'sql' && bodies.length === 1 && bodies[0] !== undefined) {
        try {
          for (const b of await parseMigration(bodies[0])) {
            await checkStatement(b, {
              ...c,
              body: true,
              handled: new Set(),
              ctes: new Set(),
              reads: new Set(),
              report: (rule, message) => c.report(rule, `in function body: ${message}`),
            });
          }
        } catch {
          c.report(
            'extension-forbidden',
            'The function body could not be parsed, so it cannot be checked.',
          );
        }
      } else if (lang === 'sql' && !n.sql_body) {
        c.report('extension-forbidden', 'The function body could not be checked.');
      }
      break;
    }
    case 'CreateSeqStmt':
    case 'AlterSeqStmt': {
      needOwnRelation(c, n.sequence, 'sequence', st.kind === 'CreateSeqStmt' ? 'create' : 'alter');
      const owned = obj(defElems(n.options).get('owned_by'))?.List;
      const parts = names(obj(owned)?.items);
      if (parts.length >= 2 && !(parts.length === 1 && parts[0]?.toLowerCase() === 'none')) {
        needOwnNameParts(c, parts.slice(0, -1), 'OWNED BY table');
      }
      break;
    }
    case 'CompositeTypeStmt':
      needOwnRelation(c, n.typevar, 'type', 'create');
      break;
    case 'CreateEnumStmt':
      needOwnName(c, n.typeName, 'type', 'create');
      break;
    case 'AlterEnumStmt':
      needOwnName(c, n.typeName, 'type');
      break;
    case 'CreateDomainStmt':
      needOwnName(c, n.domainname, 'type', 'create');
      break;
    case 'CreateTrigStmt': {
      needOwnRelation(c, n.relation, 'table', 'alter');
      const fn = names(n.funcname);
      const fname = fn.at(-1);
      const fschema = fn.length > 1 ? fn.at(-2) : undefined;
      const okFn =
        fname !== undefined &&
        (fschema === undefined || fschema === 'public') &&
        (ownsObject(c.extension, fname, c.others) ||
          (BASE_TRIGGER_FUNCTIONS as readonly string[]).includes(fname));
      if (!okFn)
        c.report(
          'extension-forbidden',
          `trigger function "${fn.join('.')}" is not allowed: use ${BASE_TRIGGER_FUNCTIONS.join(', ')} or one of this extension's own functions.`,
        );
      break;
    }
    case 'TruncateStmt':
      for (const r of arr(n.relations)) needOwnRelation(c, obj(r)?.RangeVar ?? r, 'table', 'alter');
      break;
    case 'DropStmt':
      checkDrop(c, n);
      break;
    case 'CommentStmt':
      checkComment(c, n);
      break;
    default:
  }

  if (st.kind === 'ViewStmt') return; // its query was walked above (the reads decide the security_invoker rule)
  // Generic walk: function calls, reads, writable CTEs, foreign keys, FOR UPDATE, SELECT INTO.
  walk(c, { [st.kind]: n });
}

function dropTargets(n: Node): unknown[] {
  return arr(n.objects).map((o) => {
    const ob = obj(o);
    return ob?.List
      ? obj(ob.List)?.items
      : ob?.ObjectWithArgs
        ? obj(ob.ObjectWithArgs)?.objname
        : ob?.TypeName
          ? obj(ob.TypeName)?.names
          : o;
  });
}

function checkDrop(c: Ctx, n: Node): void {
  const type = str(n.removeType) ?? '?';
  const targets = dropTargets(n);
  if (targets.some((t) => names(t).length === 0)) {
    c.report('extension-forbidden', 'DROP target could not be determined, so it is refused.');
    return;
  }
  if (DROP_RELATIONS.has(type) || DROP_FUNCTIONS.has(type) || DROP_TYPES.has(type)) {
    const what = type.replace('OBJECT_', '').toLowerCase();
    for (const t of targets) needOwnNameParts(c, names(t), what);
  } else if (type === 'OBJECT_TRIGGER') {
    for (const t of targets) needOwnNameParts(c, names(t).slice(0, -1), 'table');
  } else {
    c.report('extension-forbidden', `DROP ${type.replace('OBJECT_', '')} is not allowed.`);
  }
}

function checkComment(c: Ctx, n: Node): void {
  const type = str(n.objtype) ?? '?';
  const o = obj(n.object);
  const parts = names(
    obj(o?.List)?.items ?? obj(o?.ObjectWithArgs)?.objname ?? obj(o?.TypeName)?.names,
  );
  if (DROP_RELATIONS.has(type) || DROP_FUNCTIONS.has(type) || DROP_TYPES.has(type))
    needOwnNameParts(c, parts, type.replace('OBJECT_', '').toLowerCase());
  else if (type === 'OBJECT_COLUMN') needOwnNameParts(c, parts.slice(0, -1), 'table');
  else c.report('extension-forbidden', `COMMENT ON ${type.replace('OBJECT_', '')} is not allowed.`);
}

export interface ExtensionLintOptions {
  /**
   * Every OTHER extension known to this instance (installed or configured). A name in the namespace of one of them
   * whose prefix is longer than ours (`foo` vs `foo-bar`) is not ours, whatever its spelling.
   */
  otherExtensions?: readonly string[];
}

export async function lintExtensionStatements(
  statements: readonly ParsedStatement[],
  extension: string,
  ctx: LintContext,
  opts: ExtensionLintOptions = {},
): Promise<Finding[]> {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(extension))
    throw new Error(`"${extension}" is not a valid extension name`);
  const findings = lintStatements(statements, ctx);
  for (const st of statements) {
    const summary = st.text.replace(/\s+/g, ' ').slice(0, 80);
    // Extension rules cannot be waived. Say so instead of silently ignoring an annotation that tries to.
    for (const rule of st.allowed.keys())
      if (rule.startsWith('extension-'))
        findings.push({
          rule: 'extension-allow-ignored',
          message: `"-- sold:allow ${rule}" has no effect: extension rules cannot be waived. Fix the statement instead.`,
          line: st.line,
          statement: summary,
        });
    const c: Ctx = {
      extension,
      prefix: extensionPrefix(extension),
      others: opts.otherExtensions ?? [],
      report: (rule, message) =>
        findings.push({ rule, message, line: st.line, statement: summary }),
      handled: new Set(),
      ctes: new Set(),
      reads: new Set(),
      body: false,
    };
    await checkStatement(st, c);
  }
  return findings;
}
