import { describe, expect, it } from 'vitest';
import { InMemoryAzureInventory, InMemoryCloudflareInventory } from './fakes';
import { remediationFor, verifyEnvironmentRemoved } from './verify';

const ENV = 'demo-eph-my-branch-1a2b';

function inventories() {
  return { azure: new InMemoryAzureInventory(), cloudflare: new InMemoryCloudflareInventory() };
}

describe('verifyEnvironmentRemoved', () => {
  it('is ok when neither Azure nor Cloudflare carries the env-id', async () => {
    const result = await verifyEnvironmentRemoved(inventories(), ENV);
    expect(result).toEqual({ ok: true, leftovers: [], warnings: [] });
  });

  it('fails when a tagged Azure resource remains', async () => {
    const inv = inventories();
    inv.azure.resources.push({
      envId: ENV,
      source: 'azure',
      kind: 'microsoft.storage/storageaccounts',
      id: '/x',
      name: 'left',
    });
    const result = await verifyEnvironmentRemoved(inv, ENV);
    expect(result.ok).toBe(false);
    expect(result.leftovers.map((l) => l.name)).toEqual(['left']);
  });

  it('fails on a soft-deleted Key Vault that still reserves the name, with a purge remedy', async () => {
    const inv = inventories();
    inv.azure.softDeleted.push({
      envId: ENV,
      source: 'azure-soft-deleted-key-vault',
      kind: 'deletedVaults',
      id: '/kv',
      name: 'kv-demoephmybranc-abc123',
    });
    const result = await verifyEnvironmentRemoved(inv, ENV);
    expect(result.ok).toBe(false);
    expect(remediationFor(result.leftovers[0]!)).toBe(
      'purge it: az keyvault purge --name kv-demoephmybranc-abc123',
    );
  });

  it('fails on Cloudflare leftovers (DNS record, R2 bucket)', async () => {
    const inv = inventories();
    inv.cloudflare.items.push(
      {
        envId: ENV,
        source: 'cloudflare',
        kind: 'dns-record',
        id: '1',
        name: 'preview.example.com',
      },
      { envId: ENV, source: 'cloudflare', kind: 'r2-bucket', id: 'b', name: `sold-${ENV}` },
    );
    const result = await verifyEnvironmentRemoved(inv, ENV);
    expect(result.leftovers).toHaveLength(2);
  });

  it('ignores resources of other environments', async () => {
    const inv = inventories();
    inv.azure.resources.push({
      envId: 'demo-dev',
      source: 'azure',
      kind: 'k',
      id: '/y',
      name: 'other',
    });
    expect((await verifyEnvironmentRemoved(inv, ENV)).ok).toBe(true);
  });

  it('warns (never silently passes) when Cloudflare cannot be checked, and fails if it is required', async () => {
    const inv = inventories();
    inv.cloudflare.configured = false;
    const soft = await verifyEnvironmentRemoved(inv, ENV);
    expect(soft.ok).toBe(true);
    expect(soft.warnings[0]).toMatch(/Cloudflare was NOT verified/);
    const strict = await verifyEnvironmentRemoved(inv, ENV, { requireCloudflare: true });
    expect(strict.ok).toBe(false);
    expect(strict.leftovers[0]?.kind).toBe('unverifiable');
  });
});
