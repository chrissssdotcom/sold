import { sql } from 'drizzle-orm';
import type { PrimaryDb } from './client';
import { parseMigration } from './lint/parser';
import { extensionToken } from './extension-access';

type Node = Record<string, unknown>;
const obj = (v: unknown): Node | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : undefined;

export interface ReportingViewSpec {
  extension: string;
  name: string;
  sql: string;
}

/** Function names a reporting view may never call: file/OS/network access, session control, catalogue introspection. */
const FORBIDDEN_FN =
  /^(pg_|lo_|dblink|set_config$|current_setting$|query_to_xml|table_to_xml|cursor_to_xml|database_to_xml|schema_to_xml|nextval$|setval$|txid_|inet_server|current_user$|session_user$)/i;

/** Walk every node of the AST. */
function* walk(node: unknown): Generator<Node> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
  } else if (node && typeof node === 'object') {
    yield node as Node;
    for (const v of Object.values(node as Node)) yield* walk(v);
  }
}

/**
 * The security boundary for extension-provided reporting SQL. Views execute with their OWNER's privileges (that is how the
 * reporting role can read them without touching Base tables), so what the owner may reach must be decided here, by parsing:
 *   - exactly one statement, a plain SELECT (CTEs allowed, but only SELECT CTEs; no INTO);
 *   - every table is one of THIS extension's own tables (`ext_<token>_*`), unqualified or in `public`;
 *   - no calls into file, OS, network, session or catalogue functions.
 * An extension that wants Base data in a report must copy the (non-personal) facts it needs into its own tables.
 */
export async function validateReportingViewSql(
  extension: string,
  name: string,
  text: string,
): Promise<string[]> {
  const issues: string[] = [];
  const prefix = `ext_${extensionToken(extension)}_`;
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name))
    return [`view name "${name}" must be lowercase letters, digits and underscores`];
  let statements;
  try {
    statements = await parseMigration(text);
  } catch (error) {
    return [`SQL does not parse: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (statements.length !== 1) return ['a reporting view is exactly one SELECT statement'];
  const stmt = statements[0]!;
  if (stmt.kind !== 'SelectStmt') return [`only SELECT is allowed (found ${stmt.kind})`];
  // A WITH name is not a table: references to it are fine; what it selects FROM is checked where it is defined.
  const cteNames = new Set<string>();
  for (const node of walk(stmt.node)) {
    const cte = obj(node['CommonTableExpr']);
    if (cte) cteNames.add(String(cte['ctename']));
  }
  for (const node of walk(stmt.node)) {
    const range = obj(node['RangeVar']);
    if (range) {
      const rel = String(range['relname'] ?? '');
      const schema = range['schemaname'] === undefined ? 'public' : String(range['schemaname']);
      if (range['schemaname'] === undefined && cteNames.has(rel)) continue;
      if (schema !== 'public' || !rel.startsWith(prefix))
        issues.push(`may only read this extension's own tables (${prefix}*), not ${schema}.${rel}`);
    }
    const fn = obj(node['FuncCall']);
    if (fn) {
      const parts = (Array.isArray(fn['funcname']) ? fn['funcname'] : []).map((p) =>
        String(obj(obj(p)?.['String'])?.['sval'] ?? ''),
      );
      const last = parts[parts.length - 1] ?? '';
      if (FORBIDDEN_FN.test(last) || (parts.length > 1 && parts[0] !== 'pg_catalog'))
        issues.push(`function ${parts.join('.')} is not allowed in a reporting view`);
    }
    if (node['intoClause']) issues.push('SELECT INTO is not allowed');
    for (const forbidden of [
      'InsertStmt',
      'UpdateStmt',
      'DeleteStmt',
      'MergeStmt',
      'LockingClause',
    ])
      if (node[forbidden]) issues.push(`${forbidden} is not allowed`);
  }
  return [...new Set(issues)];
}

export interface SyncReport {
  created: string[];
  dropped: string[];
  rejected: { view: string; issues: string[] }[];
}

/**
 * Make `reporting.ext_<token>_<name>` match the enabled extensions' declarations: create or replace each valid view, drop views
 * of extensions that are gone or no longer declare them, and grant SELECT to the reporting role. A rejected view is skipped and
 * reported; it never blocks the others.
 */
export async function syncReportingViews(
  db: PrimaryDb,
  specs: readonly ReportingViewSpec[],
): Promise<SyncReport> {
  const report: SyncReport = { created: [], dropped: [], rejected: [] };
  const want = new Set<string>();
  for (const spec of specs) {
    const view = `ext_${extensionToken(spec.extension)}_${spec.name}`;
    const issues = await validateReportingViewSql(spec.extension, spec.name, spec.sql);
    if (issues.length > 0) {
      report.rejected.push({ view, issues });
      continue;
    }
    want.add(view);
    // Identifier is built from validated lowercase parts only; the SQL body was parsed and restricted above.
    await db.execute(
      sql.raw(`CREATE OR REPLACE VIEW reporting."${view}" AS ${spec.sql.replace(/;\s*$/, '')}`),
    );
    await db.execute(sql.raw(`GRANT SELECT ON reporting."${view}" TO sold_grafana`));
    report.created.push(view);
  }
  const existing = await db.execute<{ viewname: string }>(
    sql`SELECT viewname FROM pg_views WHERE schemaname = 'reporting' AND viewname LIKE 'ext\\_%'`,
  );
  for (const row of existing.rows)
    if (!want.has(row.viewname)) {
      await db.execute(sql.raw(`DROP VIEW IF EXISTS reporting."${row.viewname}"`));
      report.dropped.push(row.viewname);
    }
  return report;
}
