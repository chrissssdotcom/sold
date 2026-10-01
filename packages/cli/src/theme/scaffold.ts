import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';
import { validateTitle } from '../ext/scaffold';

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const RESERVED = ['default', 'template'];

export function validateThemeName(name: string): void {
  if (!NAME.test(name))
    throw new CliError(
      `invalid theme name "${name}": use 2-31 lower-case letters, digits and hyphens, starting with a letter`,
      ExitCode.usage,
    );
  if (RESERVED.includes(name)) throw new CliError(`"${name}" is reserved`, ExitCode.usage);
}

const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);
const tsEscape = (v: string) =>
  v.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r');
const escapeFor = (file: string) =>
  file.endsWith('.json') ? jsonEscape : /\.[cm]?[jt]sx?$/.test(file) ? tsEscape : (v: string) => v;
const titleCase = (n: string) =>
  n
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out.sort();
}

/**
 * `sold theme:new <name>`: copy `themes/_template` into `themes/<name>`. The new theme extends the default theme, so it
 * works immediately and only contains what you choose to change. Never edits `sold.config.ts` (customer-owned).
 */
export async function themeNew(
  ctx: CliContext,
  options: { name: string; title?: string },
): Promise<{ dir: string; files: string[] }> {
  validateThemeName(options.name);
  if (options.title !== undefined) validateTitle(options.title);
  const template = join(ctx.cwd, 'themes', '_template');
  if (!existsSync(template))
    throw new CliError(
      'themes/_template not found: run from the repository root',
      ExitCode.failure,
    );
  const target = join(ctx.cwd, 'themes', options.name);
  if (existsSync(target))
    throw new CliError(`themes/${options.name} already exists`, ExitCode.refused);

  const tokens: Record<string, string> = {
    __NAME__: options.name,
    __TITLE__: options.title ?? titleCase(options.name),
  };
  const render = (s: string, file = '') => {
    const escape = escapeFor(file);
    return s.replace(/__(?:NAME|TITLE)__/g, (t) => escape(tokens[t] ?? t));
  };
  const files: string[] = [];
  for (const file of await walk(template)) {
    const dest = join(target, render(relative(template, file)).replace(/\.tpl$/, ''));
    files.push(relative(ctx.cwd, dest));
    if (ctx.dryRun) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, render(await readFile(file, 'utf8'), dest));
  }
  ctx.out.info(
    `${ctx.dryRun ? 'would create' : 'created'} themes/${options.name}/ (${files.length} files)`,
  );
  ctx.out.info('next:');
  ctx.out.info('  1. pnpm install');
  ctx.out.info(`  2. set \`theme: { preset: '${options.name}' }\` in sold.config.ts`);
  ctx.out.info('  3. pnpm dev');
  return { dir: target, files };
}

/** `sold theme:list`: the default theme plus every folder under `themes/`, marking the active one. */
export async function themeList(ctx: CliContext): Promise<string[]> {
  const dir = join(ctx.cwd, 'themes');
  const found = existsSync(dir)
    ? (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map((e) => e.name)
    : [];
  const names = ['default', ...found.sort()];
  let active = 'default';
  const mod = existsSync(join(ctx.cwd, 'sold.config.ts'))
    ? await readFile(join(ctx.cwd, 'sold.config.ts'), 'utf8')
    : '';
  const m = /preset:\s*'([a-z][a-z0-9-]*)'/.exec(mod);
  if (m?.[1]) active = m[1];
  for (const n of names) ctx.out.info(`${n === active ? '*' : ' '} ${n}`);
  return names;
}
