import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { BASE_VERSION } from '@sold/core';
import { reservedExtensionNames } from '@sold/extension-sdk';
import semver from 'semver';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

const NAME = /^[a-z][a-z0-9-]{1,30}$/;

export interface ExtNewOptions {
  name: string;
  title?: string;
}

/** `^0.1.0` for 0.x (minor is the compatibility line), `^1.0.0` for 1.x. */
export function baseRangeFor(version: string): string {
  const v = semver.parse(version);
  if (!v) throw new CliError(`invalid Base version "${version}"`, ExitCode.failure);
  return v.major === 0 ? `^0.${v.minor}.0` : `^${v.major}.0.0`;
}

export function validateExtensionName(name: string): void {
  if (!NAME.test(name)) {
    throw new CliError(
      `invalid extension name "${name}": use 2-31 lower-case letters, digits and hyphens, starting with a letter`,
      ExitCode.usage,
    );
  }
  if ((reservedExtensionNames as readonly string[]).includes(name)) {
    throw new CliError(
      `"${name}" is reserved (it would collide with a Base concept or route)`,
      ExitCode.usage,
    );
  }
}

const MAX_TITLE = 200;

/**
 * The title ends up in package.json, in a TypeScript string literal and in the README. Reject what cannot be a
 * plain one-line title (control, line-separator and invisible/bidi formatting characters), then escape per
 * destination anyway: validation is not the only line of defence.
 */
export function validateTitle(title: string): void {
  if (title.trim().length === 0 || title.length > MAX_TITLE)
    throw new CliError(`invalid --title: use 1-${MAX_TITLE} characters`, ExitCode.usage);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(title))
    throw new CliError(
      'invalid --title: control, line-break and invisible formatting characters are not allowed',
      ExitCode.usage,
    );
}

/** The inside of a JSON string literal. */
const jsonEscape = (value: string) => JSON.stringify(value).slice(1, -1);
/** The inside of a single-quoted JavaScript/TypeScript string literal. */
const singleQuoteEscape = (value: string) =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');

const escapeFor = (file: string): ((value: string) => string) =>
  file.endsWith('.json')
    ? jsonEscape
    : /\.(?:[cm]?[jt]sx?)$/.test(file)
      ? singleQuoteEscape
      : (v) => v;

const titleCase = (name: string) =>
  name
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
 * `sold ext:new <name>`: copy `extensions/_template` into `extensions/<name>` with the name, table prefix and Base
 * range filled in. It never edits `sold.config.ts` (customer-owned): it prints the steps instead.
 */
export async function extNew(
  ctx: CliContext,
  options: ExtNewOptions,
): Promise<{ dir: string; files: string[] }> {
  validateExtensionName(options.name);
  if (options.title !== undefined) validateTitle(options.title);
  const template = join(ctx.cwd, 'extensions', '_template');
  if (!existsSync(template))
    throw new CliError(
      'extensions/_template not found: run from the repository root',
      ExitCode.failure,
    );
  const target = join(ctx.cwd, 'extensions', options.name);
  if (existsSync(target))
    throw new CliError(`extensions/${options.name} already exists`, ExitCode.refused);

  const tokens: Record<string, string> = {
    __NAME__: options.name,
    __PREFIX__: `ext_${options.name.replaceAll('-', '_')}_`,
    __TITLE__: options.title ?? titleCase(options.name),
    __BASE_RANGE__: baseRangeFor(BASE_VERSION),
  };
  // Values are escaped for the kind of file they land in, so a title can never break out of a string literal.
  const render = (s: string, file = '') => {
    const escape = escapeFor(file);
    // One pass, so a value that itself looks like a token is never substituted again.
    return s.replace(/__(?:NAME|PREFIX|TITLE|BASE_RANGE)__/g, (token) =>
      escape(tokens[token] ?? token),
    );
  };

  const files: string[] = [];
  for (const file of await walk(template)) {
    const rel = relative(template, file);
    const dest = join(target, render(rel).replace(/\.tpl$/, ''));
    files.push(relative(ctx.cwd, dest));
    if (ctx.dryRun) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, render(await readFile(file, 'utf8'), dest));
  }
  ctx.out.info(
    `${ctx.dryRun ? 'would create' : 'created'} extensions/${options.name}/ (${files.length} files)`,
  );
  ctx.out.info('next:');
  ctx.out.info('  1. pnpm install');
  ctx.out.info(`  2. add '${options.name}' to \`extensions\` in sold.config.ts`);
  ctx.out.info('  3. pnpm sold ext:sync && pnpm db:migrate   (pnpm dev does both locally)');
  return { dir: target, files };
}
