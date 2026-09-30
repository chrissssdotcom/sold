import type { ServiceMap, ServiceName, ServiceProvider } from '@sold/extension-sdk';
import type { ExtensionOrigin } from './load-order';

export type ProviderOrigin = 'base' | ExtensionOrigin;

/** Override precedence (docs/extending.md): instance extension > first-party extension > Base default. */
export const originPrecedence: Record<ProviderOrigin, number> = {
  instance: 3,
  'first-party': 2,
  base: 1,
};

export interface RegisteredProvider {
  service: ServiceName;
  key: string;
  origin: ProviderOrigin;
  /** `base` for Base defaults, otherwise the extension name. */
  owner: string;
  create(): unknown;
}

export class ServiceResolutionError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Cannot resolve services:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ServiceResolutionError';
  }
}

/**
 * Providers register by key; the active one per service is chosen at boot:
 *  1. an explicit selection in `sold.config.ts` (`services: { 'pricing.rounding': 'charm-pricing' }`), else
 *  2. the highest-precedence origin (instance > first-party > Base).
 * Two providers tied at the winning origin are an error, not a coin flip: pick one in config.
 */
export class ServiceRegistry {
  private readonly providers: RegisteredProvider[] = [];
  private readonly active = new Map<ServiceName, RegisteredProvider>();
  private readonly instances = new Map<ServiceName, Promise<unknown>>();

  register<K extends ServiceName>(
    provider: ServiceProvider<K>,
    origin: ProviderOrigin,
    owner: string,
  ): void {
    this.providers.push({
      service: provider.service,
      key: provider.key,
      origin,
      owner,
      create: provider.create,
    });
  }

  /** Decide the active provider for every service. Throws with every problem listed. */
  resolve(selection: Readonly<Record<string, string>> = {}): void {
    const issues: string[] = [];
    this.active.clear();
    this.instances.clear();
    const byService = new Map<ServiceName, RegisteredProvider[]>();
    for (const p of this.providers)
      byService.set(p.service, [...(byService.get(p.service) ?? []), p]);

    for (const service of Object.keys(selection)) {
      if (!byService.has(service as ServiceName))
        issues.push(`services.${service}: no provider is registered for this service`);
    }

    for (const [service, candidates] of byService) {
      const seen = new Set<string>();
      for (const c of candidates) {
        const id = `${c.owner}/${c.key}`;
        if (seen.has(id)) issues.push(`service "${service}": provider "${id}" is registered twice`);
        seen.add(id);
      }
      const chosenKey = selection[service];
      if (chosenKey !== undefined) {
        const matches = candidates.filter((c) => c.key === chosenKey);
        const best = [...matches].sort(
          (a, b) => originPrecedence[b.origin] - originPrecedence[a.origin],
        )[0];
        if (!best)
          issues.push(
            `services.${service}: selected provider "${chosenKey}" is not registered (available: ${candidates.map((c) => c.key).join(', ')})`,
          );
        else this.active.set(service, best);
        continue;
      }
      const top = Math.max(...candidates.map((c) => originPrecedence[c.origin]));
      const winners = candidates.filter((c) => originPrecedence[c.origin] === top);
      if (winners.length > 1) {
        issues.push(
          `service "${service}": ${winners.map((w) => `${w.owner}/${w.key}`).join(' and ')} tie at precedence "${winners[0]?.origin}"; select one in sold.config.ts under services`,
        );
      } else if (winners[0]) this.active.set(service, winners[0]);
    }
    if (issues.length > 0) throw new ServiceResolutionError(issues);
  }

  /** Which provider is active for a service (for diagnostics and generated docs). */
  activeProvider(
    service: ServiceName,
  ): { key: string; owner: string; origin: ProviderOrigin } | undefined {
    const p = this.active.get(service);
    return p ? { key: p.key, owner: p.owner, origin: p.origin } : undefined;
  }

  /** Lazily creates and caches the active provider. A failing factory does not poison later calls. */
  get<K extends ServiceName>(service: K): Promise<ServiceMap[K]> {
    const provider = this.active.get(service);
    if (!provider)
      return Promise.reject(new Error(`No provider is registered for service "${service}"`));
    let instance = this.instances.get(service);
    if (!instance) {
      instance = Promise.resolve().then(() => provider.create());
      instance.catch(() => this.instances.delete(service));
      this.instances.set(service, instance);
    }
    return instance as Promise<ServiceMap[K]>;
  }

  list(): {
    service: ServiceName;
    key: string;
    owner: string;
    origin: ProviderOrigin;
    active: boolean;
  }[] {
    return this.providers.map((p) => ({
      service: p.service,
      key: p.key,
      owner: p.owner,
      origin: p.origin,
      active: this.active.get(p.service) === p,
    }));
  }
}
