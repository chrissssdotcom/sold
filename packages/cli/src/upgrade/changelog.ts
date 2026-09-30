import semver from 'semver';

export const changeTags = ['breaking', 'migration', 'infra', 'security'] as const;
export type ChangeTag = (typeof changeTags)[number];

export interface ChangelogEntry {
  version: string;
  tags: ChangeTag[];
  text: string;
}

export interface ChangelogSection {
  version: string;
  date?: string | undefined;
  entries: ChangelogEntry[];
}

const HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?(?:\s*[-–]\s*(\S+))?\s*$/;
const BULLET = /^\s*[-*]\s+((?:\[[A-Za-z]+\]\s*)+)(.*)$/;

/**
 * Base's CHANGELOG.md: `## <version> - <date>` sections; entries are bullets that start with one or
 * more tags: `- [breaking][migration] Orders table gains ...`. Tags: breaking, migration, infra, security.
 * Untagged bullets are ordinary changes and are not surfaced by `upgrade:check`.
 */
export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | undefined;
  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      current = { version: heading[1], date: heading[2], entries: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const bullet = BULLET.exec(line);
    if (!bullet?.[1]) continue;
    const tags = [...bullet[1].matchAll(/\[([A-Za-z]+)\]/g)]
      .map((m) => (m[1] ?? '').toLowerCase())
      .filter((t): t is ChangeTag => (changeTags as readonly string[]).includes(t));
    if (tags.length === 0) continue;
    current.entries.push({ version: current.version, tags, text: (bullet[2] ?? '').trim() });
  }
  return sections;
}

/** Entries of every release after `from` up to and including `to`. */
export function entriesBetween(
  sections: ChangelogSection[],
  from: string,
  to: string,
): ChangelogEntry[] {
  return sections
    .filter((s) => semver.gt(s.version, from) && semver.lte(s.version, to))
    .sort((a, b) => semver.compare(a.version, b.version))
    .flatMap((s) => s.entries);
}

export function groupByTag(entries: ChangelogEntry[]): Record<ChangeTag, ChangelogEntry[]> {
  const grouped: Record<ChangeTag, ChangelogEntry[]> = {
    breaking: [],
    migration: [],
    infra: [],
    security: [],
  };
  for (const entry of entries) {
    for (const tag of entry.tags) grouped[tag].push(entry);
  }
  return grouped;
}
