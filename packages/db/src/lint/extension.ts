import { normalize, splitSql } from './sql';
import { lintStatements, type Finding } from './rules';

/**
 * Extra rules for extension migrations (Section 4): an extension may create and change only objects
 * named `ext_<name>_*`, and may never alter Base tables. It may reference Base tables by foreign key
 * from its own side tables. On top of these, the ordinary online-migration rules apply.
 */
export function extensionPrefix(extension: string): string {
  return `ext_${extension.replaceAll('-', '_')}_`;
}

const IDENT = String.raw`("[^"]+"|[a-z_][a-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:(?:public|reporting)\.)?${IDENT}`;

/** Statements whose *target object* must be namespaced, with a group capturing that object's name. */
const targets: { id: string; what: string; re: RegExp }[] = [
  {
    id: 'table',
    what: 'table',
    re: new RegExp(
      String.raw`^create (?:unlogged |temp(?:orary)? )?table (?:if not exists )?${QUALIFIED}`,
    ),
  },
  {
    id: 'table',
    what: 'table',
    re: new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${QUALIFIED}`),
  },
  {
    id: 'table',
    what: 'table',
    re: new RegExp(String.raw`^drop table (?:if exists )?${QUALIFIED}`),
  },
  {
    id: 'table',
    what: 'table',
    re: new RegExp(String.raw`^truncate (?:table )?(?:only )?${QUALIFIED}`),
  },
  { id: 'table', what: 'table', re: new RegExp(String.raw`^insert into ${QUALIFIED}`) },
  { id: 'table', what: 'table', re: new RegExp(String.raw`^update (?:only )?${QUALIFIED}`) },
  { id: 'table', what: 'table', re: new RegExp(String.raw`^delete from (?:only )?${QUALIFIED}`) },
  { id: 'table', what: 'table', re: new RegExp(String.raw`^comment on table ${QUALIFIED}`) },
  {
    id: 'table',
    what: 'table',
    re: new RegExp(String.raw`^create (?:or replace )?trigger ${IDENT} .*? on ${QUALIFIED}`),
  },
  {
    id: 'index',
    what: 'index',
    re: new RegExp(
      String.raw`^create (?:unique )?index (?:concurrently )?(?:if not exists )?${QUALIFIED} on`,
    ),
  },
  {
    id: 'index',
    what: 'index',
    re: new RegExp(String.raw`^drop index (?:concurrently )?(?:if exists )?${QUALIFIED}`),
  },
  {
    id: 'index-table',
    what: 'table',
    re: new RegExp(
      String.raw`^create (?:unique )?index (?:concurrently )?(?:if not exists )?(?:${QUALIFIED} )?on (?:only )?${QUALIFIED}`,
    ),
  },
  {
    id: 'view',
    what: 'view',
    re: new RegExp(String.raw`^create (?:or replace )?(?:materialized )?view ${QUALIFIED}`),
  },
  {
    id: 'function',
    what: 'function',
    re: new RegExp(String.raw`^create (?:or replace )?function ${QUALIFIED}`),
  },
  { id: 'type', what: 'type', re: new RegExp(String.raw`^create type ${QUALIFIED}`) },
  {
    id: 'sequence',
    what: 'sequence',
    re: new RegExp(String.raw`^create sequence (?:if not exists )?${QUALIFIED}`),
  },
];

const forbidden: { re: RegExp; message: string }[] = [
  {
    re: /^create schema\b|^drop schema\b|^alter schema\b/,
    message: 'Extensions may not create or change schemas.',
  },
  {
    re: /^create extension\b|^drop extension\b|^alter extension\b/,
    message: 'Extensions may not install database extensions; ask Base to provide it.',
  },
  { re: /^(?:grant|revoke)\b/, message: 'Extensions may not change privileges.' },
  { re: /^(?:create|alter|drop) (?:role|user)\b/, message: 'Extensions may not manage roles.' },
  {
    re: /^alter (?:database|system)\b/,
    message: 'Extensions may not change database or server settings.',
  },
  {
    re: /^(?:set|reset)\s+(?!local\b)/,
    message: 'Extensions may not change session settings; the runner sets migration timeouts.',
  },
  {
    re: /^(?:copy|do|call|listen|notify|vacuum|analyze|reindex|cluster)\b/,
    message: 'Statement is not allowed in extension migrations.',
  },
];

function unquote(s: string | undefined): string {
  return (s ?? '').replaceAll('"', '').toLowerCase();
}

export function lintExtensionSql(
  sql: string,
  extension: string,
  opts: { noTransaction: boolean },
): Finding[] {
  const prefix = extensionPrefix(extension);
  const statements = splitSql(sql);
  const findings = lintStatements(statements, opts);

  for (const st of statements) {
    const norm = normalize(st.text);
    const report = (rule: string, message: string) =>
      findings.push({
        rule,
        message,
        line: st.line,
        statement: st.text.replace(/\s+/g, ' ').slice(0, 80),
      });

    for (const f of forbidden) if (f.re.test(norm)) report('extension-forbidden', f.message);

    const seen = new Set<string>();
    for (const t of targets) {
      const m = t.re.exec(norm);
      if (!m) continue;
      // The last captured identifier is the object; for triggers/index-table forms it is the table.
      const groups = m.slice(1).filter((g): g is string => g !== undefined);
      const name = unquote(
        t.id === 'table' && /create (?:or replace )?trigger/.test(norm)
          ? groups.at(-1)
          : groups.at(-1),
      );
      const key = `${t.what}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!name.startsWith(prefix)) {
        report(
          'extension-namespace',
          t.what === 'table' && !/^create /.test(norm)
            ? `Extensions must never alter Base tables: "${name}" is not one of this extension's tables (${prefix}*). Use a side table with a foreign key, or the metadata jsonb column.`
            : `${t.what} "${name}" must be named ${prefix}*.`,
        );
      }
    }
  }
  return findings;
}
