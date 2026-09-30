/** Minimal SQL statement splitter: understands quotes, dollar-quoting and comments. */

export interface Statement {
  /** Statement text with comments removed and whitespace preserved as written. */
  text: string;
  /** Comments immediately preceding the statement (used for `-- sold:allow` annotations). */
  leadingComments: string[];
  /** 1-based line where the statement starts. */
  line: number;
}

export function splitSql(sql: string): Statement[] {
  const out: Statement[] = [];
  let buf = '';
  let comments: string[] = [];
  let pendingComments: string[] = [];
  let line = 1;
  let startLine = 1;
  let i = 0;
  const n = sql.length;

  const flush = () => {
    const text = buf.trim();
    if (text) out.push({ text, leadingComments: comments, line: startLine });
    buf = '';
    comments = [];
    pendingComments = [];
  };

  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === '\n') line++;

    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      const comment = sql.slice(i + 2, stop).trim();
      if (buf.trim() === '') pendingComments.push(comment);
      else comments.push(comment);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop;
      continue;
    }
    if (buf.trim() === '' && !/\s/.test(c)) {
      startLine = line;
      comments = [...pendingComments];
      pendingComments = [];
    }
    if (c === "'" || c === '"') {
      const end = findQuoteEnd(sql, i, c);
      buf += sql.slice(i, end);
      line += (sql.slice(i, end).match(/\n/g) ?? []).length;
      i = end;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        buf += sql.slice(i, stop);
        line += (sql.slice(i, stop).match(/\n/g) ?? []).length;
        i = stop;
        continue;
      }
    }
    if (c === ';') {
      flush();
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function findQuoteEnd(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/** Lower-cased, whitespace-collapsed form with string literals blanked, for rule matching. */
export function normalize(text: string): string {
  return text
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "'?'")
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
