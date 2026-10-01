import type { ReactNode } from 'react';
import type { BlockDefinition, ExtensionManifest, SlotMap, SlotName } from '@sold/extension-sdk';
import * as generated from '../../.generated/extensions';
import { SlotBoundary } from '../components/slot-boundary';

interface Generated {
  candidates: { manifest: ExtensionManifest }[];
  entries: { name: string; enabled: boolean }[];
}
const reg = generated as unknown as Generated;

/** Manifests of the extensions that are enabled on this instance (the generated registry is the build-time source of truth). */
export function enabledManifests(): ExtensionManifest[] {
  const on = new Set(reg.entries.filter((e) => e.enabled).map((e) => e.name));
  return reg.candidates.map((c) => c.manifest).filter((m) => on.has(m.name));
}

/** Page-builder blocks from enabled extensions, namespaced `<extension>/<type>` so they can never shadow a Base block. */
export function extensionBlockDefs(): BlockDefinition[] {
  return enabledManifests().flatMap((m) =>
    m.blocks.map((b) => ({ ...b, type: `${m.name}/${b.type}` })),
  );
}

export interface AdminScreen {
  extension: string;
  path: string;
  title: string;
  permission: string;
  section: string;
  order: number;
  component: () => Promise<{ default: (props: never) => ReactNode }>;
}

export function adminScreens(): AdminScreen[] {
  return enabledManifests().flatMap((m) =>
    m.adminScreens.map((s) => ({
      extension: m.name,
      path: s.path,
      title: s.title,
      permission: s.permission,
      section: s.nav?.section ?? 'Extensions',
      order: s.nav?.order ?? 100,
      component: s.component as AdminScreen['component'],
    })),
  );
}

/**
 * Render every enabled extension's contribution to a named slot, in `order`. Each is lazy-loaded (a slot nobody fills
 * costs nothing) and isolated: a failing contribution renders nothing rather than breaking the page.
 */
export async function ExtensionSlot<K extends SlotName>({
  name,
  props,
}: {
  name: K;
  props: SlotMap[K];
}): Promise<ReactNode> {
  const contributions = enabledManifests()
    .flatMap((m) => m.slots.filter((s) => s.slot === name).map((s) => ({ m: m.name, s })))
    .sort((a, b) => (a.s.order ?? 100) - (b.s.order ?? 100));
  if (contributions.length === 0) return null;
  const loaded = await Promise.all(
    contributions.map(async ({ m, s }) => {
      try {
        const { default: Component } = await s.component();
        return {
          key: `${m}/${s.id}`,
          Component: Component as unknown as (p: SlotMap[K]) => ReactNode,
        };
      } catch {
        return null;
      }
    }),
  );
  return (
    <>
      {loaded.map((l) =>
        l ? (
          <SlotBoundary key={l.key} label={`${name}:${l.key}`}>
            <l.Component {...props} />
          </SlotBoundary>
        ) : null,
      )}
    </>
  );
}
