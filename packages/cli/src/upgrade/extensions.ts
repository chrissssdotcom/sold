import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';

export interface ExtensionCompat {
  name: string;
  directory: string;
  /** `requires.base` semver range from the extension's package.json (`sold.requires.base`). */
  range: string | undefined;
  status: 'compatible' | 'incompatible' | 'unknown';
  reason?: string;
}

/**
 * Extension compatibility report for a target Base version. The extension declares
 * `"sold": { "requires": { "base": "<semver range>" } }` in its package.json (mirrors
 * `defineExtension({ requires: { base } })`; the manifest contract lands with the extension SDK,
 * PENDING(phase-1)). Extensions with no declaration are reported as `unknown`, never as compatible.
 */
export async function checkExtensionCompatibility(
  cwd: string,
  targetBase: string,
): Promise<ExtensionCompat[]> {
  let entries: string[];
  try {
    entries = await readdir(join(cwd, 'extensions'));
  } catch {
    return [];
  }
  const report: ExtensionCompat[] = [];
  for (const directory of entries.sort()) {
    if (directory.startsWith('_') || directory.startsWith('.')) continue;
    let pkg: { name?: string; sold?: { requires?: { base?: string } } };
    try {
      pkg = JSON.parse(
        await readFile(join(cwd, 'extensions', directory, 'package.json'), 'utf8'),
      ) as typeof pkg;
    } catch {
      continue; // not an extension package
    }
    const name = pkg.name ?? directory;
    const range = pkg.sold?.requires?.base;
    if (range === undefined) {
      report.push({
        name,
        directory,
        range,
        status: 'unknown',
        reason: 'no sold.requires.base declared',
      });
    } else if (semver.validRange(range) === null) {
      report.push({
        name,
        directory,
        range,
        status: 'unknown',
        reason: `'${range}' is not a valid semver range`,
      });
    } else if (semver.satisfies(targetBase, range, { includePrerelease: true })) {
      report.push({ name, directory, range, status: 'compatible' });
    } else {
      report.push({
        name,
        directory,
        range,
        status: 'incompatible',
        reason: `requires base ${range}, target is ${targetBase}`,
      });
    }
  }
  return report;
}
