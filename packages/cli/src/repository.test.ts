/** Consistency of the committed repository files with the code that consumes them. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateJsonSchemas, serializeSchema } from './schemas';
import { releaseJsonSchema } from './release/schemas';
import { classify, parseManifest } from './upgrade/manifest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('committed .sold files', () => {
  it('.sold/schemas are generated from the Zod sources (run `pnpm --filter @sold/cli schemas`)', () => {
    for (const [name, schema] of Object.entries(generateJsonSchemas())) {
      // Compared structurally: `pnpm format` (prettier) may lay the JSON out differently from the generator.
      expect(JSON.parse(read(`.sold/schemas/${name}`)), name).toEqual(
        JSON.parse(serializeSchema(schema)),
      );
    }
  });

  it('.sold/base-manifest.json is valid and classifies the repository layout as documented', () => {
    const manifest = parseManifest(read('.sold/base-manifest.json'), '.sold/base-manifest.json');
    const expectations: Record<string, string> = {
      'apps/web/src/app/page.tsx': 'base',
      'packages/core/src/index.ts': 'base',
      'packages/cli/src/bin.ts': 'base',
      'ops/terraform/modules/sold-environment/main.tf': 'base',
      'ops/terraform/profiles/prod.tfvars': 'base',
      'ops/terraform/environments/demo/dev/main.tf': 'base',
      'ops/terraform/environments/acme/dev/main.tf': 'customer',
      'extensions/_template/package.json': 'base',
      'extensions/my-ext/src/index.ts': 'customer',
      'sold.config.ts': 'customer',
      'config/prod.ts': 'customer',
      'environments/prod/release.json': 'customer',
      'docs/adr/0003-environments-and-upgrades.md': 'base',
      'docs/upgrading.md': 'base',
      'docs/instance/upgrades/1.1.0.md': 'customer',
      '.github/workflows/release.yml': 'base',
      '.github/workflows/env-up.yml': 'base',
      '.github/workflows/instance-drift.yml': 'customer',
      '.sold/base-manifest.json': 'base',
      '.sold/instance.json': 'customer',
      '.sold/base-version': 'generated',
      'pnpm-lock.yaml': 'generated',
      'package.json': 'base',
    };
    for (const [path, owner] of Object.entries(expectations)) {
      expect(classify(path, manifest), path).toBe(owner);
    }
  });

  it('every environments/<env>/release.json validates against the release schema', () => {
    const envs = readdirSync(join(root, 'environments'));
    expect(envs.sort()).toEqual(expect.arrayContaining(['dev', 'prod', 'stage']));
    for (const env of envs) {
      const parsed = releaseJsonSchema.safeParse(
        JSON.parse(read(`environments/${env}/release.json`)),
      );
      expect(parsed.success, env).toBe(true);
    }
  });

  it('.sold/base-version is an exact SemVer version', () => {
    expect(read('.sold/base-version')).toMatch(/^\d+\.\d+\.\d+\n$/);
  });
});
