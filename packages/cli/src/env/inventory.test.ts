import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../testing';
import { AzResourceGraphInventory, CloudflareApiInventory, type FetchLike } from './inventory';

const ENV = 'demo-eph-my-branch-1a2b';

describe('AzResourceGraphInventory', () => {
  it('lists environments from resource-group tags', async () => {
    const runner = new FakeRunner().on('az graph query', {
      stdout: JSON.stringify({
        count: 1,
        data: [
          {
            subscriptionId: 'sub-1',
            name: `rg-sold-${ENV}`,
            id: '/subscriptions/sub-1/resourceGroups/x',
            tags: {
              'sold:env-id': ENV,
              'sold:customer': 'demo',
              'sold:environment': 'eph-my-branch-1a2b',
              'sold:profile': 'ephemeral',
              'sold:owner': 'chris',
              'sold:expires-at': '2026-10-02T12:00:00Z',
              'sold:release': '0.1.0+demo.7',
            },
          },
        ],
      }),
    });
    const envs = await new AzResourceGraphInventory(runner).listEnvironments();
    expect(envs).toEqual([
      {
        envId: ENV,
        customer: 'demo',
        environment: 'eph-my-branch-1a2b',
        profile: 'ephemeral',
        owner: 'chris',
        expiresAt: '2026-10-02T12:00:00Z',
        release: '0.1.0+demo.7',
        resourceGroup: `rg-sold-${ENV}`,
        subscriptionId: 'sub-1',
      },
    ]);
    expect(runner.calls[0]?.args.join(' ')).toContain("tags['sold:env-id']");
  });

  it('finds resources by the sold:env-id tag, including the resource group', async () => {
    const runner = new FakeRunner().on('az graph query', {
      stdout: JSON.stringify([{ id: '/a', name: 'kv', type: 'microsoft.keyvault/vaults' }]),
    });
    const items = await new AzResourceGraphInventory(runner).findResources(ENV);
    expect(items).toEqual([
      { source: 'azure', kind: 'microsoft.keyvault/vaults', id: '/a', name: 'kv' },
    ]);
    expect(runner.calls[0]?.args.join(' ')).toContain(`tags['sold:env-id'] =~ '${ENV}'`);
    expect(runner.calls[0]?.args.join(' ')).toContain('ResourceContainers');
  });

  it('refuses to embed anything that is not a valid env-id in a query', async () => {
    const inv = new AzResourceGraphInventory(new FakeRunner());
    await expect(inv.findResources("x' | project secret")).rejects.toThrow(/invalid env-id/);
  });

  it('finds soft-deleted vaults by tag or by the derived name prefix', async () => {
    const runner = new FakeRunner().on('az keyvault list-deleted', {
      stdout: JSON.stringify([
        { id: '/d1', name: 'kv-demoephmybranc-abc123', properties: { tags: {} } },
        { id: '/d2', name: 'unrelated', properties: { tags: { 'sold:env-id': ENV } } },
        { id: '/d3', name: 'kv-other-zzz999', properties: { tags: {} } },
      ]),
    });
    const items = await new AzResourceGraphInventory(runner).findSoftDeletedKeyVaults(ENV);
    expect(items.map((i) => i.name)).toEqual(['kv-demoephmybranc-abc123', 'unrelated']);
  });

  it('turns az failures into errors', async () => {
    const runner = new FakeRunner().on('az graph query', {
      code: 1,
      stderr: 'Please run az login',
    });
    await expect(new AzResourceGraphInventory(runner).listEnvironments()).rejects.toThrow(
      /az login/,
    );
  });
});

describe('CloudflareApiInventory', () => {
  const scope = { accountId: 'acct1', zoneId: 'zone1' };
  const respond = (routes: Record<string, unknown>): { fetcher: FetchLike; urls: string[] } => {
    const urls: string[] = [];
    const fetcher: FetchLike = (url, init) => {
      urls.push(url);
      expect(init.method).toBe('GET');
      const match = Object.entries(routes).find(([fragment]) => url.includes(fragment));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, result: match?.[1] ?? [] }),
      });
    };
    return { fetcher, urls };
  };

  it('is not configured without a token and scope, and returns nothing', async () => {
    expect(new CloudflareApiInventory(respond({}).fetcher, undefined, scope).isConfigured()).toBe(
      false,
    );
    expect(new CloudflareApiInventory(respond({}).fetcher, 't', undefined).isConfigured()).toBe(
      false,
    );
    expect(
      await new CloudflareApiInventory(respond({}).fetcher, undefined, scope).findByEnvId(ENV),
    ).toEqual([]);
  });

  it('finds DNS records, R2 buckets, Access apps/policies, Turnstile widgets and waiting rooms for the env only', async () => {
    const { fetcher, urls } = respond({
      '/r2/buckets': { buckets: [{ name: `sold-${ENV}` }, { name: 'sold-demo-dev' }] },
      '/access/apps': [
        { id: 'a1', name: `sold-${ENV}` },
        { id: 'a2', name: `sold-${ENV}-bypass-api-webhooks` },
        { id: 'a3', name: `sold-${ENV}x` },
        { id: 'a4', name: 'sold-demo-dev' },
      ],
      '/access/policies': [
        { id: 'p1', name: `sold-${ENV}-allow` },
        { id: 'p2', name: 'sold-other-allow' },
      ],
      '/challenges/widgets': [{ sitekey: 'sk', name: `sold-${ENV}` }],
      '/dns_records': [
        { id: 'd1', name: 'x.example.com', comment: `sold:env-id=${ENV}` },
        { id: 'd2', name: 'y.example.com', comment: `sold:env-id=${ENV}-longer` },
        { id: 'd3', name: 'z.example.com', comment: 'sold:env-id=demo-dev' },
      ],
      '/waiting_rooms': [{ id: 'w1', name: `sold-${ENV}` }],
    });
    const items = await new CloudflareApiInventory(fetcher, 'token', scope).findByEnvId(ENV);
    expect(items.map((i) => `${i.kind}:${i.id}`).sort()).toEqual([
      'access-application:a1',
      'access-application:a2',
      'access-policy:p1',
      'dns-record:d1',
      'r2-bucket:sold-' + ENV,
      'turnstile-widget:sk',
      'waiting-room:w1',
    ]);
    expect(urls.every((u) => u.startsWith('https://api.cloudflare.com/client/v4/'))).toBe(true);
    expect(urls.some((u) => u.includes(encodeURIComponent(`sold:env-id=${ENV}`)))).toBe(true);
  });

  it('skips zone-scoped queries when no zone is configured', async () => {
    const { fetcher, urls } = respond({});
    await new CloudflareApiInventory(fetcher, 'token', { accountId: 'acct1' }).findByEnvId(ENV);
    expect(urls.some((u) => u.includes('/zones/'))).toBe(false);
  });

  it('surfaces API errors instead of treating them as "clean"', async () => {
    const fetcher: FetchLike = () =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({ success: false, errors: [{ message: 'Authentication error' }] }),
      });
    await expect(
      new CloudflareApiInventory(fetcher, 'token', scope).findByEnvId(ENV),
    ).rejects.toThrow(/Authentication error/);
  });

  it('describes its queries without executing them and never prints the token', () => {
    const lines = new CloudflareApiInventory(
      respond({}).fetcher,
      'secret-token',
      scope,
    ).describeVerifyQueries(ENV);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines.join('\n')).not.toContain('secret-token');
    expect(lines.join('\n')).toContain('$CLOUDFLARE_API_TOKEN');
  });
});
