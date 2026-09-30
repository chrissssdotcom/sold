import { describe, expect, it } from 'vitest';
import { entriesBetween, groupByTag, parseChangelog } from './changelog';
import { CHANGELOG_1_1_0 } from './fixture';

describe('changelog', () => {
  const sections = parseChangelog(CHANGELOG_1_1_0);

  it('parses sections and tagged entries, ignoring untagged bullets', () => {
    expect(sections.map((s) => s.version)).toEqual(['1.1.0', '1.0.1', '1.0.0']);
    expect(sections[0]?.entries).toEqual([
      { version: '1.1.0', tags: ['breaking'], text: 'Removed the legacy cart API' },
      {
        version: '1.1.0',
        tags: ['migration', 'infra'],
        text: 'Orders table gains a nullable currency column; run the migrate job before traffic shifts',
      },
      { version: '1.1.0', tags: ['security'], text: 'Rotate the session signing key on upgrade' },
    ]);
    expect(sections[0]?.date).toBe('2026-10-20');
  });

  it('selects entries after `from` up to and including `to`', () => {
    expect(entriesBetween(sections, '1.0.0', '1.0.1').map((e) => e.text)).toEqual([
      'Patched a header parsing issue',
    ]);
    expect(entriesBetween(sections, '1.0.0', '1.1.0')).toHaveLength(4);
    expect(entriesBetween(sections, '1.1.0', '1.1.0')).toEqual([]);
  });

  it('groups by tag; an entry with several tags appears under each', () => {
    const grouped = groupByTag(entriesBetween(sections, '1.0.0', '1.1.0'));
    expect(grouped.breaking).toHaveLength(1);
    expect(grouped.migration).toHaveLength(1);
    expect(grouped.infra).toHaveLength(1);
    expect(grouped.security).toHaveLength(2);
  });

  it('tolerates bracketed versions, v prefixes, unknown tags and other bullet styles', () => {
    const md =
      '## [2.0.0] - 2026-01-01\n* [BREAKING] Caps ok\n* [wip] unknown tag ignored\n- [breaking]\n\n## v1.9.0\n- [infra] x\n';
    const parsed = parseChangelog(md);
    expect(parsed.map((s) => s.version)).toEqual(['2.0.0', '1.9.0']);
    expect(parsed[0]?.entries.map((e) => e.text)).toEqual(['Caps ok', '']);
    expect(parsed[1]?.entries[0]?.tags).toEqual(['infra']);
  });
});
