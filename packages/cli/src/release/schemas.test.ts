import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_DIGEST,
  formatVersionId,
  isPlaceholderDigest,
  releaseJsonSchema,
  serializeRelease,
  versionIdSchema,
} from './schemas';

const digest = `sha256:${'b'.repeat(64)}`;
const valid = {
  baseVersion: '1.4.0',
  instanceBuild: 27,
  imageDigest: digest,
  extensionVersions: { '@acme/loyalty': '2.1.0' },
  terraformModuleVersion: '1.4.0',
};

describe('release.json schema', () => {
  it('accepts the documented shape', () => {
    expect(releaseJsonSchema.parse(valid)).toEqual(valid);
  });

  it('accepts optional worker/migrate digests (Dockerfile has separate targets)', () => {
    const parsed = releaseJsonSchema.parse({
      ...valid,
      workerImageDigest: digest,
      migrateImageDigest: digest,
    });
    expect(parsed.workerImageDigest).toBe(digest);
  });

  it.each([
    ['tag instead of digest', { imageDigest: 'latest' }],
    ['short digest', { imageDigest: 'sha256:abc' }],
    ['uppercase digest', { imageDigest: `sha256:${'A'.repeat(64)}` }],
    ['non-semver base', { baseVersion: '1.4' }],
    ['build metadata in base', { baseVersion: '1.4.0+demo.1' }],
    ['negative build', { instanceBuild: -1 }],
    ['fractional build', { instanceBuild: 1.5 }],
    ['range as extension version', { extensionVersions: { x: '^1.0.0' } }],
    ['bad module version', { terraformModuleVersion: 'main' }],
    ['unknown key', { extra: true }],
  ])('rejects %s', (_name, patch) => {
    expect(releaseJsonSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it('rejects missing fields', () => {
    const { imageDigest: _omit, ...rest } = valid;
    expect(releaseJsonSchema.safeParse(rest).success).toBe(false);
  });

  it('serializes with a stable key order and trailing newline', () => {
    const text = serializeRelease(
      releaseJsonSchema.parse({
        ...valid,
        extensionVersions: { b: '1.0.0', a: '2.0.0' },
        workerImageDigest: digest,
      }),
    );
    expect(Object.keys(JSON.parse(text))).toEqual([
      'baseVersion',
      'instanceBuild',
      'imageDigest',
      'workerImageDigest',
      'extensionVersions',
      'terraformModuleVersion',
    ]);
    expect(Object.keys(JSON.parse(text).extensionVersions)).toEqual(['a', 'b']);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('recognises the placeholder digest of a fresh scaffold', () => {
    expect(isPlaceholderDigest(PLACEHOLDER_DIGEST)).toBe(true);
    expect(isPlaceholderDigest(digest)).toBe(false);
  });
});

describe('version identifier <base-version>+<customer>.<instance-build>', () => {
  it('formats and parses', () => {
    expect(formatVersionId('demo', { baseVersion: '1.4.0', instanceBuild: 27 })).toBe(
      '1.4.0+demo.27',
    );
    expect(versionIdSchema.parse('1.4.0+demo.27')).toEqual({
      baseVersion: '1.4.0',
      customer: 'demo',
      instanceBuild: 27,
    });
    expect(versionIdSchema.parse('1.5.0-rc.1+acme.3')).toEqual({
      baseVersion: '1.5.0-rc.1',
      customer: 'acme',
      instanceBuild: 3,
    });
  });

  it.each([
    '1.4.0',
    '1.4.0+demo',
    '1.4.0+demo.x',
    'v1.4.0+demo.1',
    '1.4+demo.1',
    '1.4.0+De.1',
    '1.4.0+demo.1.2',
    '',
  ])('rejects %j', (bad) => {
    expect(versionIdSchema.safeParse(bad).success).toBe(false);
  });

  it('round-trips through a valid semver with build metadata', () => {
    const id = formatVersionId('demo', { baseVersion: '2.0.0', instanceBuild: 1 });
    expect(versionIdSchema.parse(id).baseVersion).toBe('2.0.0');
  });

  it('refuses to format for an invalid customer', () => {
    expect(() =>
      formatVersionId('Not_Valid', { baseVersion: '1.0.0', instanceBuild: 1 }),
    ).toThrow();
  });
});
