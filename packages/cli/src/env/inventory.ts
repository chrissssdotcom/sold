import { formatCommand, type ProcessRunner } from '../lib/process';
import { validateEnvId } from './ids';

/** Something that carries (or is named after) a `sold:env-id`. */
export interface InventoryItem {
  source: 'azure' | 'azure-soft-deleted-key-vault' | 'cloudflare';
  kind: string;
  id: string;
  name: string;
}

/** An environment as Azure describes it: the resource group and its mandatory tags. */
export interface EnvironmentSummary {
  envId: string;
  customer: string;
  environment: string;
  profile: string;
  owner: string;
  expiresAt: string;
  release: string;
  resourceGroup: string;
  subscriptionId: string;
}

/** Azure side of `env:list`, `env:down --verify` and the concurrency guard. */
export interface AzureInventory {
  listEnvironments(): Promise<EnvironmentSummary[]>;
  /** Every resource carrying the tag `sold:env-id = <envId>` (including the resource group). */
  findResources(envId: string): Promise<InventoryItem[]>;
  /** Soft-deleted Key Vaults still reserving a name. */
  findSoftDeletedKeyVaults(envId: string): Promise<InventoryItem[]>;
  /** The queries above, as text, for `--dry-run`. */
  describeVerifyQueries(envId: string): string[];
}

export interface CloudflareScope {
  accountId: string;
  zoneId?: string | undefined;
}

/** Cloudflare side of `env:down --verify`. */
export interface CloudflareInventory {
  /** True when credentials/scope are configured; false means verification cannot run. */
  isConfigured(): boolean;
  findByEnvId(envId: string): Promise<InventoryItem[]>;
  describeVerifyQueries(envId: string): string[];
}

// ---------------------------------------------------------------------------------------------
// Azure: Resource Graph through the `az` CLI (the same auth as every other step).
// ---------------------------------------------------------------------------------------------

interface GraphRow {
  [key: string]: unknown;
}

function graphRows(stdout: string): GraphRow[] {
  const parsed: unknown = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed as GraphRow[];
  if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) {
    const data = (parsed as { data: unknown }).data;
    if (Array.isArray(data)) return data as GraphRow[];
  }
  throw new Error('unexpected `az graph query` output shape');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function tagsOf(row: GraphRow): Record<string, string> {
  const tags = row['tags'];
  return typeof tags === 'object' && tags !== null ? (tags as Record<string, string>) : {};
}

export class AzResourceGraphInventory implements AzureInventory {
  constructor(private readonly runner: ProcessRunner) {}

  private async graph(query: string): Promise<GraphRow[]> {
    const result = await this.runner.run('az', [
      'graph',
      'query',
      '-q',
      query,
      '--first',
      '1000',
      '-o',
      'json',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `az graph query failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      );
    }
    return graphRows(result.stdout);
  }

  private static readonly envsQuery =
    "ResourceContainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' " +
    "| where isnotempty(tags['sold:env-id']) | project subscriptionId, name, id, tags";

  private static resourcesQuery(envId: string): string {
    validateEnvId(envId); // validated charset: safe to embed in a query string
    return (
      `Resources | where tags['sold:env-id'] =~ '${envId}' | project id, name, type ` +
      `| union (ResourceContainers | where tags['sold:env-id'] =~ '${envId}' | project id, name, type)`
    );
  }

  async listEnvironments(): Promise<EnvironmentSummary[]> {
    const rows = await this.graph(AzResourceGraphInventory.envsQuery);
    return rows.map((row) => {
      const tags = tagsOf(row);
      return {
        envId: tags['sold:env-id'] ?? '',
        customer: tags['sold:customer'] ?? '',
        environment: tags['sold:environment'] ?? '',
        profile: tags['sold:profile'] ?? '',
        owner: tags['sold:owner'] ?? '',
        expiresAt: tags['sold:expires-at'] ?? '',
        release: tags['sold:release'] ?? '',
        resourceGroup: str(row['name']),
        subscriptionId: str(row['subscriptionId']),
      };
    });
  }

  async findResources(envId: string): Promise<InventoryItem[]> {
    const rows = await this.graph(AzResourceGraphInventory.resourcesQuery(envId));
    return rows.map((row) => ({
      source: 'azure' as const,
      kind: str(row['type']),
      id: str(row['id']),
      name: str(row['name']),
    }));
  }

  async findSoftDeletedKeyVaults(envId: string): Promise<InventoryItem[]> {
    validateEnvId(envId);
    const result = await this.runner.run('az', ['keyvault', 'list-deleted', '-o', 'json']);
    if (result.code !== 0) {
      throw new Error(
        `az keyvault list-deleted failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      );
    }
    const vaults = JSON.parse(result.stdout) as GraphRow[];
    const prefix = `kv-${envId.replace(/-/g, '').slice(0, 14)}-`;
    return vaults
      .filter((vault) => {
        const props = (vault['properties'] ?? {}) as GraphRow;
        const tags = { ...tagsOf(props), ...tagsOf(vault) };
        return tags['sold:env-id'] === envId || str(vault['name']).startsWith(prefix);
      })
      .map((vault) => ({
        source: 'azure-soft-deleted-key-vault' as const,
        kind: 'Microsoft.KeyVault/deletedVaults',
        id: str(vault['id']),
        name: str(vault['name']),
      }));
  }

  describeVerifyQueries(envId: string): string[] {
    return [
      formatCommand('az', [
        'graph',
        'query',
        '-q',
        AzResourceGraphInventory.resourcesQuery(envId),
        '-o',
        'json',
      ]),
      formatCommand('az', ['keyvault', 'list-deleted', '-o', 'json']),
    ];
  }
}

// ---------------------------------------------------------------------------------------------
// Cloudflare: read-only API calls (`GET`), token from the environment, injected fetch.
// ---------------------------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface CfListResponse {
  success?: boolean;
  result?: unknown;
  errors?: { message?: string }[];
}

const CF_API = 'https://api.cloudflare.com/client/v4';

export class CloudflareApiInventory implements CloudflareInventory {
  constructor(
    private readonly fetcher: FetchLike,
    private readonly token: string | undefined,
    private readonly scope: CloudflareScope | undefined,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.token && this.scope?.accountId);
  }

  private endpoints(
    envId: string,
  ): { kind: string; url: string; pick: (result: unknown) => InventoryItem[] }[] {
    const scope = this.scope;
    if (!scope) return [];
    const account = `${CF_API}/accounts/${scope.accountId}`;
    const nameMatches = (name: string, exact: string[], prefixes: string[]): boolean =>
      exact.includes(name) || prefixes.some((p) => name.startsWith(p));
    const items = (
      kind: string,
      rows: unknown,
      match: (row: Record<string, unknown>) => boolean,
    ): InventoryItem[] =>
      (Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []).filter(match).map((row) => ({
        source: 'cloudflare' as const,
        kind,
        id: str(row['id']) || str(row['sitekey']) || str(row['name']),
        name: str(row['name']),
      }));
    const list = [
      {
        kind: 'r2-bucket',
        url: `${account}/r2/buckets`,
        pick: (result: unknown) =>
          items(
            'r2-bucket',
            (result as { buckets?: unknown } | null)?.buckets,
            (r) => str(r['name']) === `sold-${envId}`,
          ),
      },
      {
        kind: 'access-application',
        url: `${account}/access/apps?per_page=100`,
        pick: (result: unknown) =>
          items('access-application', result, (r) =>
            nameMatches(str(r['name']), [`sold-${envId}`], [`sold-${envId}-bypass-`]),
          ),
      },
      {
        kind: 'access-policy',
        url: `${account}/access/policies?per_page=100`,
        pick: (result: unknown) =>
          items('access-policy', result, (r) =>
            nameMatches(str(r['name']), [`sold-${envId}-allow`, `sold-${envId}-bypass`], []),
          ),
      },
      {
        kind: 'turnstile-widget',
        url: `${account}/challenges/widgets?per_page=100`,
        pick: (result: unknown) =>
          items('turnstile-widget', result, (r) => str(r['name']) === `sold-${envId}`),
      },
    ];
    if (scope.zoneId) {
      const zone = `${CF_API}/zones/${scope.zoneId}`;
      const commentToken = new RegExp(`(^|\\s)sold:env-id=${envId}(?![a-z0-9-])`);
      list.push(
        {
          kind: 'dns-record',
          url: `${zone}/dns_records?comment.contains=${encodeURIComponent(`sold:env-id=${envId}`)}&per_page=100`,
          pick: (result: unknown) =>
            items('dns-record', result, (r) => commentToken.test(str(r['comment']))),
        },
        {
          kind: 'waiting-room',
          url: `${zone}/waiting_rooms`,
          pick: (result: unknown) =>
            items('waiting-room', result, (r) => str(r['name']) === `sold-${envId}`),
        },
      );
    }
    return list;
  }

  async findByEnvId(envId: string): Promise<InventoryItem[]> {
    validateEnvId(envId);
    if (!this.isConfigured()) return [];
    const found: InventoryItem[] = [];
    for (const endpoint of this.endpoints(envId)) {
      const response = await this.fetcher(endpoint.url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token ?? ''}`,
          'Content-Type': 'application/json',
        },
      });
      const body = (await response.json()) as CfListResponse;
      if (!response.ok || body.success === false) {
        const message = body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${response.status}`;
        throw new Error(`Cloudflare ${endpoint.kind} query failed: ${message}`);
      }
      found.push(...endpoint.pick(body.result));
    }
    return found;
  }

  describeVerifyQueries(envId: string): string[] {
    return this.endpoints(envId).map(
      (e) => `GET ${e.url}   (Authorization: Bearer $CLOUDFLARE_API_TOKEN)`,
    );
  }
}
