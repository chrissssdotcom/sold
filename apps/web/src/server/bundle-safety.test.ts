import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === '.generated') return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|int\.test|e2e)\.tsx?$/.test(name) ? [p] : [];
  });
}

/**
 * The worker is a single-file CommonJS bundle (esbuild). There `import.meta.url` is `undefined`, so a TOP-LEVEL use in any module the
 * worker imports crashes it at boot, with every unit test still green. (This shipped once: the reporting-view parser; found only by
 * running the bundle.) Uses must be lazy (inside a function) or live in tooling the worker never imports.
 */
describe('worker bundle safety', () => {
  it('no package module touches import.meta at top level', () => {
    const offenders: string[] = [];
    for (const dir of ['packages', 'extensions'])
      for (const pkg of readdirSync(join(root, dir))) {
        const src = join(root, dir, pkg, 'src');
        try {
          statSync(src);
        } catch {
          continue;
        }
        for (const file of sources(src)) {
          const rel = relative(root, file);
          // Tooling the worker never imports: CLIs, test support, lint config.
          if (
            /^packages\/(cli|config)\//.test(rel) ||
            /\/cli\//.test(rel) ||
            /test-support\.ts$/.test(rel)
          )
            continue;
          readFileSync(file, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              if (/^(export\s+)?(const|let|var)\s.*\bimport\.meta\b/.test(line))
                offenders.push(`${rel}:${i + 1}`);
            });
        }
      }
    expect(offenders).toEqual([]);
  });
});
