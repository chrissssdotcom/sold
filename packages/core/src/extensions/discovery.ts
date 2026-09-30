import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isExtensionManifest, type ExtensionManifest } from '@sold/extension-sdk';
import { normalizeExtensions, type SoldConfig } from '../config';
import type { ExtensionEntry, ExtensionOrigin } from './load-order';

/**
 * Build-time discovery: which extensions are in `sold.config.ts`, where their code lives, and which migrations
 * they ship. The web and worker bundles import extensions STATICALLY (a bundler cannot follow a dynamic
 * `import(name)`), so discovery writes a generated module (`apps/web/.generated/extensions.ts`) that imports
 * exactly the configured extensions. Base never edits customer files: the generated file is a build artifact.
 */

export interface DiscoveredExtension {
  name: string;
  /** Directory under `extensions/`. */
  directory: string;
  /** Absolute path of the extension's TypeScript entry. */
  entry: string;
  /** Absolute path of the package root. */
  root: string;
  origin: ExtensionOrigin;
  enabled: boolean;
  manifest: ExtensionManifest;
  /** Migration file names (sorted), empty when the extension ships none. */
  migrationFiles: string[];
}

export interface DiscoveryResult {
  extensions: DiscoveredExtension[];
  entries: ExtensionEntry[];
  services: Record<string, string>;
  /** Warnings that do not stop the build (e.g. an installed but unconfigured extension). */
  warnings: string[];
}

export class DiscoveryError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Extension discovery failed:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'DiscoveryError';
  }
}

/** First-party extensions are the Base-owned paths `extensions/<dir>/**` in `.sold/base-manifest.json`. */
export async function firstPartyDirectories(root: string): Promise<Set<string>> {
  try {
    const manifest = JSON.parse(await readFile(join(root, '.sold/base-manifest.json'), 'utf8')) as {
      baseOwned?: string[];
    };
    const dirs = new Set<string>();
    for (const glob of manifest.baseOwned ?? []) {
      const m = /^extensions\/([^/*]+)\/\*\*$/.exec(glob);
      if (m?.[1] && !m[1].startsWith('_')) dirs.add(m[1]);
    }
    return dirs;
  } catch {
    return new Set();
  }
}

async function readPackageEntry(root: string): Promise<string | undefined> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    exports?: unknown;
    main?: string;
  };
  const exp = pkg.exports;
  const target =
    typeof exp === 'string'
      ? exp
      : exp && typeof exp === 'object'
        ? ((exp as Record<string, unknown>)['.'] as unknown)
        : pkg.main;
  return typeof target === 'string' ? resolve(root, target) : undefined;
}

/** Load `sold.config.ts` (needs a TypeScript-capable runtime such as tsx) and discover its extensions. */
export async function discoverExtensions(
  root: string,
  loadConfig?: () => Promise<SoldConfig>,
): Promise<DiscoveryResult> {
  const config = loadConfig
    ? await loadConfig()
    : ((await import(pathToFileURL(join(root, 'sold.config.ts')).href)) as { default: SoldConfig })
        .default;
  const configured = normalizeExtensions(config);
  const firstParty = await firstPartyDirectories(root);
  const issues: string[] = [];
  const warnings: string[] = [];
  const extensions: DiscoveredExtension[] = [];

  const installed = existsSync(join(root, 'extensions'))
    ? (await readdir(join(root, 'extensions')))
        .filter((d) => !d.startsWith('_') && !d.startsWith('.'))
        .sort()
    : [];
  const configuredNames = new Set(configured.map((c) => c.name));

  for (const entry of configured) {
    const directory = entry.name;
    const extRoot = join(root, 'extensions', directory);
    if (!existsSync(join(extRoot, 'package.json'))) {
      issues.push(
        `extension "${entry.name}" is listed in sold.config.ts but extensions/${directory}/ does not exist`,
      );
      continue;
    }
    const entryFile = await readPackageEntry(extRoot);
    if (!entryFile || !existsSync(entryFile)) {
      issues.push(`extensions/${directory}/package.json has no usable "exports" entry`);
      continue;
    }
    let manifest: unknown;
    try {
      manifest = ((await import(pathToFileURL(entryFile).href)) as { default?: unknown }).default;
    } catch (error) {
      issues.push(
        `extensions/${directory}: cannot load ${relative(root, entryFile)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!isExtensionManifest(manifest)) {
      issues.push(
        `extensions/${directory}: the default export of ${relative(root, entryFile)} is not a defineExtension() manifest`,
      );
      continue;
    }
    if (manifest.name !== directory)
      issues.push(
        `extensions/${directory}: manifest name "${manifest.name}" must equal its directory name`,
      );
    // The compatibility check in `sold upgrade:check` reads the static mirror in package.json: keep them in sync.
    const pkg = JSON.parse(await readFile(join(extRoot, 'package.json'), 'utf8')) as {
      sold?: { requires?: { base?: string } };
    };
    if (pkg.sold?.requires?.base !== manifest.requires.base) {
      issues.push(
        `extensions/${directory}/package.json "sold.requires.base" (${pkg.sold?.requires?.base ?? 'missing'}) must equal the manifest's requires.base (${manifest.requires.base})`,
      );
    }
    const migrationFiles =
      manifest.migrations && existsSync(join(extRoot, manifest.migrations.dir))
        ? (await readdir(join(extRoot, manifest.migrations.dir)))
            .filter((f) => f.endsWith('.sql'))
            .sort()
        : [];
    extensions.push({
      name: manifest.name,
      directory,
      entry: entryFile,
      root: extRoot,
      origin: firstParty.has(directory) ? 'first-party' : 'instance',
      enabled: entry.enabled,
      manifest,
      migrationFiles,
    });
  }
  for (const dir of installed) {
    if (!configuredNames.has(dir))
      warnings.push(
        `extensions/${dir}/ is installed but not listed in sold.config.ts: it is not loaded`,
      );
  }
  if (issues.length > 0) throw new DiscoveryError(issues);
  return {
    extensions,
    entries: configured.map((c) => ({ name: c.name, enabled: c.enabled, settings: c.settings })),
    services: config.services,
    warnings,
  };
}

/**
 * The identifier a generated module binds an extension to. Extension names are kebab-case and may equal a
 * reserved word (`default`, `class`, `delete`, `import`, `await`...), so the name is never used bare: a fixed
 * `ext_` prefix makes it a valid, collision-free identifier (`-` becomes `_`, and names cannot contain `_`, so
 * the mapping is injective).
 */
export const registryIdentifier = (name: string): string => `ext_${name.replaceAll('-', '_')}`;

/**
 * Source of `apps/web/.generated/extensions.ts`. Imports use paths relative to the generated file so the bundler
 * (Next/Turbopack for web, esbuild for the worker) follows and compiles them.
 */
export function renderRegistryModule(result: DiscoveryResult, generatedFile: string): string {
  const dir = resolve(generatedFile, '..');
  const rel = (abs: string) => {
    const r = relative(dir, abs.replace(/\.tsx?$/, ''))
      .split(sep)
      .join('/');
    return r.startsWith('.') ? r : `./${r}`;
  };
  const lines = [
    '// GENERATED by `sold ext:sync` from sold.config.ts. Do not edit; it is rewritten on every build.',
    "import type { ExtensionCandidate, ExtensionEntry } from '@sold/core/extensions';",
    ...result.extensions.map((e) => `import ${registryIdentifier(e.name)} from '${rel(e.entry)}';`),
    '',
    'export const candidates: ExtensionCandidate[] = [',
    ...result.extensions.map(
      (e) => `  { manifest: ${registryIdentifier(e.name)}, origin: '${e.origin}' },`,
    ),
    '];',
    '',
    `export const entries: ExtensionEntry[] = ${JSON.stringify(result.entries, null, 2)};`,
    '',
    `export const services: Record<string, string> = ${JSON.stringify(result.services, null, 2)};`,
    '',
    '/** Migration file names per extension, known at build time (the runtime image has no `extensions/` directory). */',
    `export const migrationFiles: Record<string, readonly string[]> = ${JSON.stringify(Object.fromEntries(result.extensions.map((e) => [e.name, e.migrationFiles])), null, 2)};`,
    '',
    '/** Absolute package roots on the BUILD machine: only meaningful where the sources exist (local development, the migrate job). */',
    `export const roots: Record<string, string> = ${JSON.stringify(Object.fromEntries(result.extensions.map((e) => [e.name, e.root])), null, 2)};`,
    '',
  ];
  return lines.join('\n');
}
