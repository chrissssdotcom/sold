/** Small typed accessors over libpg-query AST nodes. Nodes are plain JSON; these keep the rules readable. */
export type Node = Record<string, unknown>;

export const obj = (v: unknown): Node | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : undefined;
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Unwrap `{ Kind: {...} }` wrappers used for list elements. */
export function unwrap(v: unknown): { kind: string; node: Node } | undefined {
  const o = obj(v);
  const kind = o && Object.keys(o)[0];
  const node = kind ? obj(o[kind]) : undefined;
  return kind && node ? { kind, node } : undefined;
}

/** Strings of a name list: `[{String:{sval:'public'}},{String:{sval:'t'}}]` -> ['public','t']. */
export function names(list: unknown): string[] {
  return arr(list)
    .map((n) => str(obj(obj(n)?.String)?.sval))
    .filter((s): s is string => s !== undefined);
}

export interface RelName {
  schema: string | undefined;
  name: string;
  temporary: boolean;
}

export function relation(v: unknown): RelName | undefined {
  const r = obj(v);
  const name = str(r?.relname);
  if (!r || !name) return undefined;
  return { schema: str(r.schemaname), name, temporary: r.relpersistence === 't' };
}

/** Identity used to compare tables: unqualified means `public`. Case is exactly as PostgreSQL stored it. */
export const tableKey = (r: { schema?: string | undefined; name: string }): string =>
  `${r.schema ?? 'public'}.${r.name}`;

export function qualified(list: unknown): RelName | undefined {
  const n = names(list);
  const name = n.at(-1);
  return name ? { schema: n.length > 1 ? n.at(-2) : undefined, name, temporary: false } : undefined;
}

/** Depth-first search for FuncCall nodes anywhere inside an expression. */
export function functionCalls(expr: unknown, out: string[] = []): string[] {
  if (Array.isArray(expr)) {
    for (const e of expr) functionCalls(e, out);
  } else if (expr && typeof expr === 'object') {
    for (const [k, v] of Object.entries(expr as Node)) {
      if (k === 'FuncCall') out.push(names(obj(v)?.funcname).at(-1)?.toLowerCase() ?? '?');
      functionCalls(v, out);
    }
  }
  return out;
}
