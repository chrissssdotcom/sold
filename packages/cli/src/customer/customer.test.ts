import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../lib/errors';
import { isProduction } from '../env/profiles';
import { releaseJsonSchema } from '../release/schemas';
import { instanceMarkerSchema } from '../upgrade/drift';
import { cleanup, makeContext, tempDir, writeTree } from '../testing';
import { customerNew, renderConfigOverlay } from './new';
import { readTemplate, renderTemplate, renderTerraformEnvironment } from './render';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function target(): string {
  const dir = tempDir('sold-customer-');
  dirs.push(dir);
  return join(dir, 'acme-instance');
}

describe('template rendering', () => {
  it('substitutes placeholders and drops solo lines whose value is empty', () => {
    expect(renderTemplate('a {{x}}\n{{opt}}\nb', { x: '1', opt: '' })).toBe('a 1\nb');
    expect(renderTemplate('a\n{{opt}}\nb', { opt: 'line1\nline2' })).toBe('a\nline1\nline2\nb');
  });

  it('refuses unknown placeholders (a typo must not ship)', () => {
    expect(() => renderTemplate('{{nope}}', {})).toThrow(/no value/);
  });
});

describe('scaffolded Terraform roots', () => {
  it('the committed demo roots are exactly what customer:new renders (they cannot drift apart)', async () => {
    for (const environment of ['dev', 'ephemeral'] as const) {
      const rendered = await renderTerraformEnvironment({
        customer: 'demo',
        environment,
        stateAccount: 'stsolddemotfstate',
        registryName: 'acrsolddemo',
      });
      for (const [file, content] of Object.entries(rendered)) {
        const committed = readFileSync(
          join(repoRoot, 'ops/terraform/environments/demo', environment, file),
          'utf8',
        );
        expect(committed, `${environment}/${file}`).toBe(content);
      }
    }
  });

  it('stage takes capacity from a tier file; prod is protected and uses its own state container', async () => {
    const stage = await renderTerraformEnvironment({ customer: 'acme', environment: 'stage' });
    expect(stage['main.tf']).toContain('profiles/tier-standard.tfvars');
    expect(stage['versions.tf']).toContain('container_name       = "tfstate"');
    expect(stage['versions.tf']).toContain('key                  = "stage.tfstate"');
    expect(stage['terraform.tfvars']).toContain('tier            = "standard"');

    const prod = await renderTerraformEnvironment({ customer: 'acme', environment: 'prod' });
    expect(prod['versions.tf']).toContain('container_name       = "tfstate-prod"');
    expect(prod['main.tf']).toContain('purge_soft_delete_on_destroy    = false');
    expect(prod['main.tf']).toContain('profile     = "prod"');
    expect(prod['main.tf']).toContain('expires_at  = "never"');
    expect(prod['terraform.tfvars']).toMatch(/access = \{\n {2}enabled = false\n\}/);
    expect(prod['main.tf']).not.toContain('{{');
  });

  it('ephemeral roots take the backend key at init time and keep inputs in state', async () => {
    const eph = await renderTerraformEnvironment({ customer: 'acme', environment: 'ephemeral' });
    expect(eph['versions.tf']).not.toMatch(/^\s*key\s*=/m);
    expect(eph['outputs.tf']).toContain('output "inputs"');
    expect(eph['main.tf']).toContain('prevent_deletion_if_contains_resources = false');
  });
});

describe('customer:new', () => {
  const ctxFor = (cwd: string, extra = {}) => makeContext({ cwd, ...extra });

  it('generates the instance scaffold: config, overlays, releases, Terraform roots, base version and marker', async () => {
    const dir = target();
    const ctx = ctxFor(repoRoot);
    const result = await customerNew(ctx, {
      name: 'acme',
      dir,
      baseVersion: '1.4.0',
      displayName: 'Acme Pty Ltd',
      upstream: 'https://example.com/sold.git',
    });

    expect(result.files).toEqual(
      expect.arrayContaining([
        'sold.config.ts',
        '.sold/base-version',
        '.sold/instance.json',
        'config/dev.ts',
        'config/stage.ts',
        'config/prod.ts',
        'environments/dev/release.json',
        'environments/stage/release.json',
        'environments/prod/release.json',
        'ops/terraform/environments/acme/dev/main.tf',
        'ops/terraform/environments/acme/stage/main.tf',
        'ops/terraform/environments/acme/prod/main.tf',
        'ops/terraform/environments/acme/ephemeral/main.tf',
        'docs/instance/README.md',
        '.github/workflows/instance-drift.yml',
        'extensions/.gitkeep',
      ]),
    );
    expect(readFileSync(join(dir, '.sold/base-version'), 'utf8')).toBe('1.4.0\n');
    expect(
      instanceMarkerSchema.parse(
        JSON.parse(readFileSync(join(dir, '.sold/instance.json'), 'utf8')),
      ),
    ).toEqual({
      customer: 'acme',
      upstream: 'https://example.com/sold.git',
      createdWithBaseVersion: '1.4.0',
    });
    const config = readFileSync(join(dir, 'sold.config.ts'), 'utf8');
    expect(config).toContain("instance: { name: 'Acme Pty Ltd', customer: 'acme' }");

    // release records validate against the schema and carry an obviously-placeholder digest
    const release = releaseJsonSchema.parse(
      JSON.parse(readFileSync(join(dir, 'environments/prod/release.json'), 'utf8')),
    );
    expect(release).toMatchObject({
      baseVersion: '1.4.0',
      instanceBuild: 0,
      terraformModuleVersion: '1.4.0',
    });
    expect(release.imageDigest).toBe(`sha256:${'0'.repeat(64)}`);

    // no template placeholder survives anywhere
    const all = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) =>
      e.isFile(),
    );
    for (const f of all) {
      expect(readFileSync(join(f.parentPath, f.name), 'utf8'), f.name).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('scaffolded prod is recognised as production by the destroy guard, dev is not', async () => {
    const dir = target();
    await customerNew(ctxFor(repoRoot), { name: 'acme', dir, baseVersion: '1.4.0' });
    expect((await isProduction({ cwd: dir, envId: 'acme-prod' })).prod).toBe(true);
    expect((await isProduction({ cwd: dir, envId: 'acme-dev' })).prod).toBe(false);
  });

  it('the drift workflow passes branch names through the environment, not inline in the script', async () => {
    const workflow = await readTemplate('instance/instance-drift.yml.tpl');
    expect(workflow).toContain('BASE_REF: ${{ github.base_ref }}');
    expect(workflow).toContain('--base-ref "origin/$BASE_REF"');
    expect(workflow).not.toMatch(/run:.*\$\{\{ github\.(head|base)_ref/);
  });

  it('pins the Base version of the current repository by default', async () => {
    const cwd = tempDir();
    dirs.push(cwd);
    writeTree(cwd, { '.sold/base-version': '2.3.4\n' });
    const dir = target();
    await customerNew(ctxFor(cwd), { name: 'acme', dir });
    expect(readFileSync(join(dir, '.sold/base-version'), 'utf8')).toBe('2.3.4\n');
    await expect(customerNew(ctxFor(tempDir()), { name: 'acme', dir: target() })).rejects.toThrow(
      /cannot determine the Base version/,
    );
  });

  it('rejects invalid customer names and non-empty targets', async () => {
    await expect(
      customerNew(ctxFor(repoRoot), { name: 'Acme Inc', dir: target(), baseVersion: '1.0.0' }),
    ).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });
    const dir = target();
    writeTree(dir, { 'existing.txt': 'x' });
    await expect(
      customerNew(ctxFor(repoRoot), { name: 'acme', dir, baseVersion: '1.0.0' }),
    ).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    expect(existsSync(join(dir, 'sold.config.ts'))).toBe(false);
  });

  it('--dry-run lists the files and writes nothing', async () => {
    const dir = target();
    const ctx = ctxFor(repoRoot, { dryRun: true });
    const result = await customerNew(ctx, { name: 'acme', dir, baseVersion: '1.0.0' });
    expect(existsSync(dir)).toBe(false);
    expect(ctx.out.lines[0]).toContain(`would create ${result.files.length} file(s)`);
    expect(ctx.out.lines.join('\n')).toContain('ops/terraform/environments/acme/prod/main.tf');
  });

  it('renders per-environment config overlays', async () => {
    const template = await readTemplate('instance/config-overlay.ts.tpl');
    const prod = renderConfigOverlay(template, 'prod');
    expect(prod).toContain('prod overrides');
    expect(prod).toContain('waiting room');
    expect(prod).toContain('const overrides: Partial<SoldConfigInput> = {};');
  });
});
