import type {
  AzureInventory,
  CloudflareInventory,
  EnvironmentSummary,
  InventoryItem,
} from './inventory';

/** In-memory Azure: what tests (and only tests) use instead of Resource Graph. */
export class InMemoryAzureInventory implements AzureInventory {
  environments: EnvironmentSummary[] = [];
  resources: (InventoryItem & { envId: string })[] = [];
  softDeleted: (InventoryItem & { envId: string })[] = [];
  queried: string[] = [];
  failWith: Error | undefined;

  listEnvironments(): Promise<EnvironmentSummary[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve([...this.environments]);
  }

  findResources(envId: string): Promise<InventoryItem[]> {
    this.queried.push(`resources:${envId}`);
    return Promise.resolve(this.resources.filter((r) => r.envId === envId));
  }

  findSoftDeletedKeyVaults(envId: string): Promise<InventoryItem[]> {
    this.queried.push(`soft-deleted:${envId}`);
    return Promise.resolve(this.softDeleted.filter((r) => r.envId === envId));
  }

  describeVerifyQueries(envId: string): string[] {
    return [
      `(fake) azure resources tagged sold:env-id=${envId}`,
      `(fake) soft-deleted key vaults for ${envId}`,
    ];
  }
}

export class InMemoryCloudflareInventory implements CloudflareInventory {
  configured = true;
  items: (InventoryItem & { envId: string })[] = [];
  queried: string[] = [];

  isConfigured(): boolean {
    return this.configured;
  }

  findByEnvId(envId: string): Promise<InventoryItem[]> {
    this.queried.push(envId);
    return Promise.resolve(this.items.filter((i) => i.envId === envId));
  }

  describeVerifyQueries(envId: string): string[] {
    return [`(fake) cloudflare objects for ${envId}`];
  }
}

export function environmentSummary(
  overrides: Partial<EnvironmentSummary> = {},
): EnvironmentSummary {
  const envId = overrides.envId ?? 'demo-eph-my-branch-1a2b';
  return {
    envId,
    customer: 'demo',
    environment: envId.replace(/^demo-/, ''),
    profile: 'ephemeral',
    owner: 'chris',
    expiresAt: '2026-10-02T12:00:00Z',
    release: '0.1.0+demo.7',
    resourceGroup: `rg-sold-${envId}`,
    subscriptionId: '22222222-2222-2222-2222-222222222222',
    ...overrides,
  };
}
