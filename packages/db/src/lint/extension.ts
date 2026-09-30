import { arr, names, obj, qualified, relation, str, unwrap, type Node } from './ast';
import type { ParsedStatement } from './parser';
import { lintStatements, type Finding, type LintContext } from './rules';

/**
 * Extra rules for extension migrations (Section 4): an extension may create and change only objects named
 * `ext_<name>_*` in the public schema, and may never alter Base tables. It may reference Base tables by foreign
 * key from its own side tables. On top of these, the ordinary online-migration rules apply.
 */
export function extensionPrefix(extension: string): string {
  return `ext_${extension.replaceAll('-', '_')}_`;
}

const FORBIDDEN: Record<string, string> = {
  CreateSchemaStmt: 'Extensions may not create or change schemas.',
  CreateExtensionStmt: 'Extensions may not install database extensions; ask Base to provide it.',
  AlterExtensionStmt: 'Extensions may not change database extensions.',
  GrantStmt: 'Extensions may not change privileges.',
  GrantRoleStmt: 'Extensions may not change privileges.',
  CreateRoleStmt: 'Extensions may not manage roles.',
  AlterRoleStmt: 'Extensions may not manage roles.',
  AlterRoleSetStmt: 'Extensions may not manage roles.',
  DropRoleStmt: 'Extensions may not manage roles.',
  AlterDatabaseStmt: 'Extensions may not change database settings.',
  AlterDatabaseSetStmt: 'Extensions may not change database settings.',
  AlterSystemStmt: 'Extensions may not change server settings.',
  VariableSetStmt:
    'Extensions may not change session settings; the runner sets migration timeouts.',
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
  CreateEventTrigStmt: 'Extensions may not create event triggers.',
};

interface Target {
  what: string;
  name: string;
  schema: string | undefined;
  /** True for statements that CHANGE existing objects (as opposed to creating new ones). */
  alters: boolean;
}

/** Objects a statement creates, changes or writes. */
function targets(st: ParsedStatement): Target[] {
  const n = st.node;
  const rel = (v: unknown, what: string, alters: boolean): Target[] => {
    const r = relation(v);
    return r ? [{ what, name: r.name, schema: r.schema, alters }] : [];
  };
  const qual = (list: unknown, what: string, alters: boolean): Target[] => {
    const q = qualified(list);
    return q ? [{ what, name: q.name, schema: q.schema, alters }] : [];
  };
  switch (st.kind) {
    case 'CreateStmt':
      return rel(n.relation, 'table', false);
    case 'AlterTableStmt':
      return rel(n.relation, 'table', true);
    case 'IndexStmt':
      return [
        ...rel(n.relation, 'table', true),
        ...(str(n.idxname)
          ? [
              {
                what: 'index',
                name: str(n.idxname) as string,
                schema: str(obj(n.relation)?.schemaname),
                alters: false,
              },
            ]
          : []),
      ];
    case 'ViewStmt':
      return rel(n.view, 'view', false);
    case 'CreateTableAsStmt':
      return rel(obj(n.into)?.rel, 'table', false);
    case 'CreateFunctionStmt':
      return qual(n.funcname, 'function', false);
    case 'CreateSeqStmt':
      return rel(n.sequence, 'sequence', false);
    case 'CompositeTypeStmt':
      return rel(n.typevar, 'type', false);
    case 'CreateEnumStmt':
    case 'CreateDomainStmt':
      return qual(n.typeName ?? n.domainname, 'type', false);
    case 'CreateTrigStmt':
      return rel(n.relation, 'table', true);
    case 'InsertStmt':
    case 'UpdateStmt':
    case 'DeleteStmt':
      return rel(n.relation, 'table', true);
    case 'TruncateStmt':
      return arr(n.relations).flatMap((r) => rel(unwrap(r)?.node, 'table', true));
    case 'RenameStmt':
      return rel(n.relation, 'table', true);
    case 'DropStmt': {
      const type = str(n.removeType) ?? '';
      const what = type.replace('OBJECT_', '').toLowerCase();
      return arr(n.objects).flatMap((o) => {
        const items = obj(o)?.List ? obj(obj(o)?.List)?.items : o;
        const listNames = names(items);
        if (type === 'OBJECT_TRIGGER' || type === 'OBJECT_POLICY' || type === 'OBJECT_RULE') {
          // Named `<trigger> ON <table>`: the table is the second-to-last element.
          const tableName = listNames.at(-2);
          return tableName
            ? [
                {
                  what: 'table',
                  name: tableName,
                  schema: listNames.length > 2 ? listNames.at(-3) : undefined,
                  alters: true,
                },
              ]
            : [];
        }
        const q = qualified(items);
        return q ? [{ what, name: q.name, schema: q.schema, alters: type === 'OBJECT_TABLE' }] : [];
      });
    }
    case 'CommentStmt': {
      const q = qualified(obj(n.object)?.List ? obj(obj(n.object)?.List)?.items : n.object);
      return q && str(n.objtype) === 'OBJECT_TABLE'
        ? [{ what: 'table', name: q.name, schema: q.schema, alters: true }]
        : [];
    }
    default:
      return [];
  }
}

export async function lintExtensionStatements(
  statements: readonly ParsedStatement[],
  extension: string,
  ctx: LintContext,
): Promise<Finding[]> {
  const prefix = extensionPrefix(extension);
  const findings = lintStatements(statements, ctx);
  for (const st of statements) {
    const report = (rule: string, message: string) => {
      if (st.allowed.has(rule)) return;
      findings.push({
        rule,
        message,
        line: st.line,
        statement: st.text.replace(/\s+/g, ' ').slice(0, 80),
      });
    };
    const forbidden = FORBIDDEN[st.kind];
    if (
      forbidden &&
      !(
        st.kind === 'VariableSetStmt' &&
        str((st.node as Node).kind) === 'VAR_SET_VALUE' &&
        (st.node as Node).is_local === true
      )
    )
      report('extension-forbidden', forbidden);
    for (const t of targets(st)) {
      const schemaOk = t.schema === undefined || t.schema === 'public';
      if (!schemaOk)
        report(
          'extension-namespace',
          `${t.what} "${t.schema}.${t.name}" is in schema "${t.schema}": extensions may only use the public schema.`,
        );
      else if (!t.name.startsWith(prefix)) {
        report(
          'extension-namespace',
          t.alters && t.what === 'table'
            ? `Extensions must never alter Base tables: "${t.name}" is not one of this extension's tables (${prefix}*). Use a side table with a foreign key, or the metadata jsonb column.`
            : `${t.what} "${t.name}" must be named ${prefix}*.`,
        );
      }
    }
  }
  return findings;
}
