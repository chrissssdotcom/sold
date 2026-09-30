import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../lib/errors';
import { cleanup, makeContext, tempDir, writeTree } from '../testing';
import { collectExtensionVersions, promote, readRelease, stampRelease } from './promote';
import { PLACEHOLDER_DIGEST, serializeRelease, type ReleaseJson } from './schemas';

const d = (c: string): string => `sha256:${c.repeat(64)}`;
const release = (overrides: Partial<ReleaseJson> = {}): ReleaseJson => ({
  baseVersion: '1.4.0',
  instanceBuild: 27,
  imageDigest: d('a'),
  extensionVersions: {},
  terraformModuleVersion: '1.4.0',
  ...overrides,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

function repo(files: Record<string, ReleaseJson>) {
  const dir = tempDir();
  dirs.push(dir);
  writeTree(
    dir,
    Object.fromEntries(
      Object.entries(files).map(([env, r]) => [
        `environments/${env}/release.json`,
        serializeRelease(r),
      ]),
    ),
  );
  return dir;
}

describe('promote', () => {
  it('copies the source release to the target without changing the image digest', async () => {
    const dir = repo({
      dev: release({ instanceBuild: 30, imageDigest: d('c') }),
      stage: release(),
    });
    const ctx = makeContext({ cwd: dir });
    const result = await promote(ctx, { from: 'dev', to: 'stage' });
    expect(result).toMatchObject({
      changed: true,
      versionId: '1.4.0+demo.30',
      branch: 'promote/stage-1-4-0-demo-30',
    });
    expect(result.title).toBe('chore(release): promote 1.4.0+demo.30 to stage');
    const written = JSON.parse(
      await readFile(join(dir, 'environments/stage/release.json'), 'utf8'),
    );
    expect(written.imageDigest).toBe(d('c'));
    expect(written.instanceBuild).toBe(30);
  });

  it('creates the target when it does not exist yet', async () => {
    const dir = repo({ dev: release() });
    await promote(makeContext({ cwd: dir }), { from: 'dev', to: 'stage' });
    expect((await readRelease(dir, 'stage'))?.instanceBuild).toBe(27);
  });

  it('is a no-op when the target already has the release', async () => {
    const dir = repo({ dev: release(), stage: release() });
    const ctx = makeContext({ cwd: dir });
    const result = await promote(ctx, { from: 'dev', to: 'stage' });
    expect(result.changed).toBe(false);
    expect(ctx.out.lines[0]).toContain('nothing to promote');
  });

  it('only moves forward one rung at a time', async () => {
    const dir = repo({ dev: release(), stage: release(), prod: release() });
    const ctx = makeContext({ cwd: dir });
    await expect(promote(ctx, { from: 'dev', to: 'prod' })).rejects.toThrow(/would skip stage/);
    await expect(promote(ctx, { from: 'prod', to: 'stage' })).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    await expect(promote(ctx, { from: 'stage', to: 'stage' })).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    await expect(promote(ctx, { from: 'dev', to: 'qa' })).rejects.toMatchObject({
      exitCode: ExitCode.usage,
    });
    await expect(promote(ctx, { from: 'dev', to: 'prod', allowSkip: true })).resolves.toBeDefined();
  });

  it('refuses to downgrade the target unless told to (rollback)', async () => {
    const dir = repo({
      dev: release({ instanceBuild: 20 }),
      stage: release({ instanceBuild: 27 }),
    });
    const ctx = makeContext({ cwd: dir });
    await expect(promote(ctx, { from: 'dev', to: 'stage' })).rejects.toThrow(
      /already runs a newer release/,
    );
    await expect(
      promote(ctx, { from: 'dev', to: 'stage', allowDowngrade: true }),
    ).resolves.toMatchObject({ changed: true });
  });

  it('orders releases by base version before build number', async () => {
    const dir = repo({
      dev: release({ baseVersion: '1.3.9', instanceBuild: 99 }),
      stage: release({ baseVersion: '1.4.0', instanceBuild: 1 }),
    });
    await expect(promote(makeContext({ cwd: dir }), { from: 'dev', to: 'stage' })).rejects.toThrow(
      /newer release/,
    );
  });

  it('refuses to promote a placeholder digest (nothing has been built)', async () => {
    const dir = repo({ dev: release({ imageDigest: PLACEHOLDER_DIGEST }) });
    await expect(promote(makeContext({ cwd: dir }), { from: 'dev', to: 'stage' })).rejects.toThrow(
      /placeholder image digest/,
    );
  });

  it('reports invalid or missing release files clearly', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeTree(dir, { 'environments/dev/release.json': '{"baseVersion":"nope"}' });
    await expect(promote(makeContext({ cwd: dir }), { from: 'dev', to: 'stage' })).rejects.toThrow(
      /release.json is invalid/,
    );
    await expect(promote(makeContext({ cwd: dir }), { from: 'stage', to: 'prod' })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('--dry-run prints the file and the PR details without writing', async () => {
    const dir = repo({ dev: release() });
    const ctx = makeContext({ cwd: dir, dryRun: true });
    await promote(ctx, { from: 'dev', to: 'stage' });
    expect(await readRelease(dir, 'stage')).toBeUndefined();
    expect(ctx.out.lines.join('\n')).toContain('would write environments/stage/release.json');
    expect(ctx.out.lines.join('\n')).toContain('promote/stage-1-4-0-demo-27');
  });
});

describe('release:stamp', () => {
  it('records a new dev build, incrementing the instance build', async () => {
    const dir = repo({ dev: release({ instanceBuild: 27 }) });
    writeTree(dir, {
      '.sold/base-version': '1.5.0\n',
      'extensions/loyalty/package.json': JSON.stringify({
        name: '@acme/loyalty',
        version: '2.1.0',
      }),
      'extensions/_template/package.json': JSON.stringify({
        name: '@sold/ext-template',
        version: '0.0.0',
      }),
      'extensions/notanext/README.md': 'x',
    });
    const stamped = await stampRelease(makeContext({ cwd: dir }), {
      imageDigest: d('e'),
      workerImageDigest: d('f'),
    });
    expect(stamped).toMatchObject({
      baseVersion: '1.5.0',
      instanceBuild: 28,
      imageDigest: d('e'),
      workerImageDigest: d('f'),
      extensionVersions: { '@acme/loyalty': '2.1.0' },
      terraformModuleVersion: '1.5.0',
    });
    expect((await readRelease(dir, 'dev'))?.instanceBuild).toBe(28);
  });

  it('starts at build 1 and only ever stamps dev', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeTree(dir, { '.sold/base-version': '0.1.0\n' });
    expect(
      (await stampRelease(makeContext({ cwd: dir }), { imageDigest: d('1') })).instanceBuild,
    ).toBe(1);
    await expect(
      stampRelease(makeContext({ cwd: dir }), { environment: 'prod', imageDigest: d('1') }),
    ).rejects.toMatchObject({
      exitCode: ExitCode.refused,
    });
    await expect(
      stampRelease(makeContext({ cwd: dir }), { imageDigest: 'latest' }),
    ).rejects.toThrow();
  });

  it('collects extension versions, skipping templates and non-packages', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeTree(dir, {
      'extensions/a/package.json': JSON.stringify({ name: 'ext-a', version: '1.0.0' }),
      'extensions/b/package.json': JSON.stringify({ name: 'ext-b', version: 'not-semver' }),
    });
    expect(await collectExtensionVersions(dir)).toEqual({ 'ext-a': '1.0.0' });
    expect(await collectExtensionVersions(join(dir, 'missing'))).toEqual({});
  });
});
