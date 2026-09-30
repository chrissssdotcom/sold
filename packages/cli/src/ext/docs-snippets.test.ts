import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * docs/extending.md is a tutorial over the REAL loyalty-points extension. Every code block that follows a
 * `<!-- from: path -->` marker must appear verbatim (modulo whitespace) in that file, so the guide cannot drift from
 * code that the platform's own tests run.
 */
const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const doc = readFileSync(join(repoRoot, 'docs/extending.md'), 'utf8');

const blocks = [...doc.matchAll(/<!-- from: (\S+) -->\s*```[a-z]*\n([\s\S]*?)```/g)].map((m) => ({
  file: m[1] as string,
  code: m[2] as string,
}));

describe('docs/extending.md snippets', () => {
  it('has snippets to check', () => expect(blocks.length).toBeGreaterThanOrEqual(8));

  it.each(blocks.map((b, i) => [`${i + 1}. ${b.file}`, b] as const))(
    '%s matches the source file',
    (_name, block) => {
      const source = norm(readFileSync(join(repoRoot, block.file), 'utf8'));
      expect(source, `snippet not found verbatim in ${block.file}:\n${block.code}`).toContain(
        norm(block.code),
      );
    },
  );

  it('every `sold` command the guide recommends exists in the CLI', () => {
    const cli = readFileSync(join(repoRoot, 'packages/cli/src/cli.ts'), 'utf8');
    const mentioned = new Set(
      [...doc.matchAll(/pnpm sold ([a-z]+:[a-z-]+)/g)].map((m) => m[1] as string),
    );
    expect(mentioned.size).toBeGreaterThanOrEqual(4);
    for (const cmd of mentioned)
      expect(cli, `pnpm sold ${cmd} is not a CLI command`).toContain(`.command('${cmd}')`);
  });
});
