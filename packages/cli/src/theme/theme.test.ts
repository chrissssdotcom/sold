import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanup, makeContext, tempDir } from '../testing';
import { themeList, themeNew, validateThemeName } from './scaffold';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const setup = () => {
  const dir = tempDir();
  cpSync(join(repoRoot, 'themes/_template'), join(dir, 'themes/_template'), { recursive: true });
  return dir;
};

describe('theme:new', () => {
  it('scaffolds a theme that extends the default theme, with name and title filled in', async () => {
    const dir = setup();
    try {
      const { files } = await themeNew(makeContext({ cwd: dir }), {
        name: 'sunset',
        title: 'Sunset: warm and bold',
      });
      expect(files.sort()).toEqual([
        'themes/sunset/README.md',
        'themes/sunset/components/footer.tsx',
        'themes/sunset/css.d.ts',
        'themes/sunset/index.ts',
        'themes/sunset/package.json',
        'themes/sunset/theme.css',
        'themes/sunset/tsconfig.json',
      ]);
      const pkg = JSON.parse(readFileSync(join(dir, 'themes/sunset/package.json'), 'utf8'));
      expect(pkg.name).toBe('@sold-theme/sunset');
      expect(pkg.description).toBe('Sunset: warm and bold');
      const index = readFileSync(join(dir, 'themes/sunset/index.ts'), 'utf8');
      expect(index).toContain("name: 'sunset'");
      expect(index).toContain('extends: defaultTheme');
      expect(index).not.toMatch(/__[A-Z_]+__/);
    } finally {
      cleanup(dir);
    }
  });

  it('a hostile title cannot break out of JSON or a string literal', async () => {
    const dir = setup();
    try {
      await themeNew(makeContext({ cwd: dir }), { name: 'quoted', title: `It's "quoted" \\ done` });
      expect(() =>
        JSON.parse(readFileSync(join(dir, 'themes/quoted/package.json'), 'utf8')),
      ).not.toThrow();
      expect(readFileSync(join(dir, 'themes/quoted/index.ts'), 'utf8')).toContain("It\\'s");
    } finally {
      cleanup(dir);
    }
  });

  it('validates names, refuses to overwrite, and supports dry runs', async () => {
    for (const bad of ['Bad', 'a', 'default', 'template', '../x', 'a b'])
      expect(() => validateThemeName(bad)).toThrow();
    const dir = setup();
    try {
      await themeNew(makeContext({ cwd: dir }), { name: 'once' });
      await expect(themeNew(makeContext({ cwd: dir }), { name: 'once' })).rejects.toThrow(
        /already exists/,
      );
      await themeNew(makeContext({ cwd: dir, dryRun: true }), { name: 'dry' });
      expect(existsSync(join(dir, 'themes/dry'))).toBe(false);
      await expect(
        themeNew(makeContext({ cwd: dir }), { name: 'x1', title: 'bad\ntitle' }),
      ).rejects.toThrow(/invalid --title/);
    } finally {
      cleanup(dir);
    }
  });

  it('theme:list shows default plus customer themes and marks the active preset', async () => {
    const dir = setup();
    try {
      await themeNew(makeContext({ cwd: dir }), { name: 'sunset' });
      writeFileSync(
        join(dir, 'sold.config.ts'),
        "export default { theme: { preset: 'sunset' } };\n",
      );
      const ctx = makeContext({ cwd: dir });
      expect(await themeList(ctx)).toEqual(['default', 'sunset']);
      expect(ctx.out.lines.some((l: string) => l.startsWith('* sunset'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
