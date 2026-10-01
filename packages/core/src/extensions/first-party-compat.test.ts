import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { BASE_VERSION } from '../version';

const extensionsDir = join(__dirname, '..', '..', '..', '..', 'extensions');

/**
 * `upgrade:check` refuses an upgrade when an installed extension's `sold.requires.base` does not admit the target. First-party extensions
 * ship in Base, so a release that bumps `BASE_VERSION` without bumping them would block every customer's upgrade (found by rehearsing
 * `upgrade:check` against a tagged 0.2.0). This fails the release commit instead.
 */
describe('first-party extensions admit the Base version they ship with', () => {
  const dirs = readdirSync(extensionsDir).filter((d) =>
    statSync(join(extensionsDir, d, 'package.json'), { throwIfNoEntry: false })?.isFile(),
  );

  it('finds the first-party extensions', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(3);
  });

  it.each(dirs)('%s', (dir) => {
    const pkg = JSON.parse(readFileSync(join(extensionsDir, dir, 'package.json'), 'utf8')) as {
      sold?: { requires?: { base?: string } };
    };
    const range = pkg.sold?.requires?.base;
    expect(range, `${dir} must declare sold.requires.base`).toBeTruthy();
    expect(semver.satisfies(BASE_VERSION, range!), `${dir} requires ${range}`).toBe(true);
  });
});
