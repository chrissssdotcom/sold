import semver from 'semver';
import type { ExtensionManifest } from '@sold/extension-sdk';

/** First-party extensions ship with Base; instance extensions are the customer's own. Used for override precedence. */
export type ExtensionOrigin = 'first-party' | 'instance';

export interface ExtensionCandidate {
  manifest: ExtensionManifest;
  origin: ExtensionOrigin;
}

export interface ExtensionEntry {
  name: string;
  enabled: boolean;
  settings?: Record<string, unknown>;
}

export interface LoadedExtension {
  manifest: ExtensionManifest;
  origin: ExtensionOrigin;
  /** Position in the resolved load order (0-based). */
  index: number;
}

export class ExtensionLoadError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Cannot load extensions:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ExtensionLoadError';
  }
}

export interface LoadOrderInput {
  baseVersion: string;
  candidates: readonly ExtensionCandidate[];
  /** Config entries in the order the operator wrote them. Only enabled entries are loaded. */
  entries: readonly ExtensionEntry[];
}

/**
 * Deterministic load order (Section 4): dependencies first; ties broken by the order in `sold.config.ts`,
 * then by name. Fails fast with EVERY problem listed: unknown or duplicate extensions, an incompatible Base
 * version, missing/disabled/incompatible dependencies, and dependency cycles (with the cycle path).
 */
export function resolveLoadOrder(input: LoadOrderInput): LoadedExtension[] {
  const issues: string[] = [];
  const byName = new Map<string, ExtensionCandidate>();
  for (const c of input.candidates) {
    if (byName.has(c.manifest.name))
      issues.push(`extension "${c.manifest.name}" is provided more than once`);
    byName.set(c.manifest.name, c);
  }

  const seen = new Set<string>();
  const configIndex = new Map<string, number>();
  input.entries.forEach((e, i) => {
    if (seen.has(e.name))
      issues.push(`extension "${e.name}" is listed more than once in sold.config.ts`);
    seen.add(e.name);
    configIndex.set(e.name, i);
  });

  const enabledNames = input.entries.filter((e) => e.enabled).map((e) => e.name);
  const enabled = new Set(enabledNames);

  for (const name of enabledNames) {
    if (!byName.has(name))
      issues.push(
        `extension "${name}" is enabled in sold.config.ts but no such extension is installed`,
      );
  }

  const active = enabledNames
    .map((n) => byName.get(n))
    .filter((c): c is ExtensionCandidate => c !== undefined);

  for (const { manifest } of active) {
    if (!semver.satisfies(input.baseVersion, manifest.requires.base, { includePrerelease: true })) {
      issues.push(
        `extension "${manifest.name}@${manifest.version}" requires Base ${manifest.requires.base} but this is Base ${input.baseVersion}`,
      );
    }
    for (const [dep, range] of Object.entries(manifest.requires.extensions)) {
      const depCandidate = byName.get(dep);
      if (!depCandidate) {
        issues.push(
          `extension "${manifest.name}" requires "${dep}" (${range}), which is not installed`,
        );
      } else if (!enabled.has(dep)) {
        issues.push(
          `extension "${manifest.name}" requires "${dep}" (${range}), which is not enabled`,
        );
      } else if (
        !semver.satisfies(depCandidate.manifest.version, range, { includePrerelease: true })
      ) {
        issues.push(
          `extension "${manifest.name}" requires "${dep}" ${range} but "${dep}" is ${depCandidate.manifest.version}`,
        );
      }
    }
  }

  // Topological order (Kahn), picking the lowest (config index, name) among ready nodes for determinism.
  const activeNames = new Set(active.map((c) => c.manifest.name));
  const remaining = new Map<string, Set<string>>();
  for (const { manifest } of active) {
    remaining.set(
      manifest.name,
      new Set(Object.keys(manifest.requires.extensions).filter((d) => activeNames.has(d))),
    );
  }
  const order: string[] = [];
  const rank = (n: string) => [configIndex.get(n) ?? Number.MAX_SAFE_INTEGER, n] as const;
  const byRank = (a: string, b: string) => {
    const [ai, an] = rank(a);
    const [bi, bn] = rank(b);
    return ai - bi || an.localeCompare(bn);
  };
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => deps.size === 0)
      .map(([n]) => n)
      .sort(byRank);
    const next = ready[0];
    if (next === undefined) {
      issues.push(`dependency cycle: ${findCycle(remaining).join(' -> ')}`);
      break;
    }
    order.push(next);
    remaining.delete(next);
    for (const deps of remaining.values()) deps.delete(next);
  }

  if (issues.length > 0) throw new ExtensionLoadError(issues);

  return order.map((name, index) => {
    const c = byName.get(name) as ExtensionCandidate;
    return { manifest: c.manifest, origin: c.origin, index };
  });
}

function findCycle(graph: Map<string, Set<string>>): string[] {
  const start = [...graph.keys()].sort()[0] as string;
  const path: string[] = [];
  const onPath = new Set<string>();
  const visit = (n: string): string[] | null => {
    if (onPath.has(n)) return [...path.slice(path.indexOf(n)), n];
    if (!graph.has(n)) return null;
    onPath.add(n);
    path.push(n);
    for (const d of [...(graph.get(n) ?? [])].sort()) {
      const found = visit(d);
      if (found) return found;
    }
    path.pop();
    onPath.delete(n);
    return null;
  };
  return visit(start) ?? [start];
}
