import { createRequire } from 'node:module';

/**
 * PostgreSQL's own parser (libpg-query, compiled to WASM, no native build) so the migration rules reason about
 * real syntax: quoted identifiers, every ALTER TABLE action, inline constraints, dynamic SQL and so on.
 * The package's ESM entry cannot load its own CommonJS helper under plain Node, so the CJS entry is used.
 */
type Node = Record<string, unknown>;

interface RawParse {
  stmts: { stmt: Node; stmt_location?: number; stmt_len?: number }[];
}
interface PgQuery {
  loadModule(): Promise<void>;
  parseSync(sql: string): RawParse;
}

let loaded: Promise<PgQuery> | undefined;

async function parser(): Promise<PgQuery> {
  loaded ??= (async () => {
    // Created lazily, not at import: this module is imported (via `@sold/db`) by the worker's single-file CJS bundle, where esbuild
    // turns `import.meta.url` into `undefined` and a top-level `createRequire(undefined)` would crash the worker at boot.
    // Only tooling (CLI, tests) ever parses, and there `import.meta.url` exists.
    const require = createRequire(import.meta.url);
    const pq = require('@libpg-query/parser') as PgQuery;
    await pq.loadModule();
    return pq;
  })();
  return loaded;
}

export class SqlSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlSyntaxError';
  }
}

export interface ParsedStatement {
  /** AST node type, e.g. `AlterTableStmt`. */
  kind: string;
  node: Node;
  /** Offsets of the statement text itself (leading comments excluded) in the source. */
  start: number;
  end: number;
  /** 1-based line of `start`. */
  line: number;
  text: string;
  /** `-- sold:allow <rule>: <reason>` annotations in the comment lines directly above the statement. */
  allowed: Map<string, string>;
  /** Malformed `-- sold:allow` comments (missing rule or reason). */
  badAnnotations: string[];
}

const ALLOW = /^\s*sold:allow\s+([a-z0-9-]+)\s*:\s*(\S.*)$/;
const ALLOW_ANY = /^\s*sold:allow\b/;

/**
 * Split the source into statements with their annotations. `stmt_location` points just after the previous `;`, so
 * the slice begins with that statement's leading comments (and any trailing comment of the previous one on the same
 * line, which belongs to the previous statement and is ignored).
 */
export async function parseMigration(sql: string): Promise<ParsedStatement[]> {
  const pq = await parser();
  let raw: RawParse;
  try {
    raw = pq.parseSync(sql);
  } catch (error) {
    throw new SqlSyntaxError(error instanceof Error ? error.message : String(error));
  }
  return raw.stmts.map((s) => {
    const from = s.stmt_location ?? 0;
    const to = s.stmt_len ? from + s.stmt_len : sql.length;
    const allowed = new Map<string, string>();
    const bad: string[] = [];
    let i = from;
    let sawNewline = false;
    for (;;) {
      while (i < to && /\s/.test(sql[i] as string)) {
        if (sql[i] === '\n') sawNewline = true;
        i++;
      }
      if (sql.startsWith('--', i)) {
        const eol = sql.indexOf('\n', i);
        const stop = eol === -1 ? to : Math.min(eol, to);
        const comment = sql.slice(i + 2, stop);
        if (sawNewline || from === 0) {
          const m = ALLOW.exec(comment);
          if (m?.[1] && m[2]) allowed.set(m[1], m[2].trim());
          else if (ALLOW_ANY.test(comment)) bad.push(comment.trim());
        }
        i = stop;
      } else if (sql.startsWith('/*', i)) {
        const close = sql.indexOf('*/', i + 2);
        i = close === -1 ? to : close + 2;
      } else break;
    }
    const kind = Object.keys(s.stmt)[0] as string;
    const text = sql.slice(i, to).trim();
    return {
      kind,
      node: s.stmt[kind] as Node,
      start: i,
      end: to,
      line: sql.slice(0, i).split('\n').length,
      text,
      allowed,
      badAnnotations: bad,
    };
  });
}
