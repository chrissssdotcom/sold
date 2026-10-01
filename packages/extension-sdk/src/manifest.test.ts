import { describe, expect, it } from 'vitest';
import {
  defineBlock,
  defineExtension,
  defineJob,
  isExtensionManifest,
  ManifestError,
  z,
  type ExtensionDefinition,
} from './index';

const lazy = () => Promise.resolve({ default: () => null });

const base: ExtensionDefinition = {
  name: 'loyalty',
  version: '1.0.0',
  requires: { base: '^0.1.0' },
  performance: { hotPath: false },
};

const issuesOf = (def: unknown): string[] => {
  try {
    defineExtension(def as ExtensionDefinition);
  } catch (e) {
    expect(e).toBeInstanceOf(ManifestError);
    return (e as ManifestError).issues;
  }
  return [];
};

describe('defineExtension', () => {
  it('accepts a minimal manifest and fills defaults', () => {
    const m = defineExtension(base);
    expect(isExtensionManifest(m)).toBe(true);
    expect(m.tablePrefix).toBe('ext_loyalty_');
    expect(m.performance).toEqual({ hotPath: false, budgetMs: 10 });
    expect(m.observers).toEqual([]);
    expect(Object.isFrozen(m)).toBe(true);
  });

  it('derives the table prefix from kebab-case names', () => {
    expect(defineExtension({ ...base, name: 'loyalty-points' }).tablePrefix).toBe(
      'ext_loyalty_points_',
    );
  });

  it('rejects bad names, versions and ranges, listing every problem', () => {
    const issues = issuesOf({
      ...base,
      name: 'Loyalty!',
      version: 'one',
      requires: { base: 'not a range' },
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.join('\n')).toMatch(/name/);
    expect(issues.join('\n')).toMatch(/version/);
    expect(issues.join('\n')).toMatch(/requires\.base/);
  });

  it('rejects reserved names', () => {
    expect(issuesOf({ ...base, name: 'admin' }).join()).toMatch(/reserved/);
  });

  it('enforces the performance contract for hot-path hooks', () => {
    const interceptor = {
      hook: 'cart.item.adding' as const,
      name: 'limit',
      failPolicy: 'open' as const,
      handler: () => undefined,
    };
    expect(issuesOf({ ...base, interceptors: [interceptor] }).join()).toMatch(
      /hotPath must be true/,
    );
    expect(() =>
      defineExtension({
        ...base,
        performance: { hotPath: true, budgetMs: 5 },
        interceptors: [interceptor],
      }),
    ).not.toThrow();
    expect(issuesOf({ ...base, performance: { hotPath: true } }).join()).toMatch(/no interceptors/);
    expect(
      issuesOf({
        ...base,
        performance: { hotPath: true, budgetMs: 500 },
        interceptors: [interceptor],
      }).join(),
    ).toMatch(/budgetMs/);
  });

  it('requires a fail policy on interceptors and caps their timeout', () => {
    const noPolicy = { hook: 'cart.item.adding', name: 'x', handler: () => undefined };
    expect(
      issuesOf({ ...base, performance: { hotPath: true }, interceptors: [noPolicy] }).join(),
    ).toMatch(/failPolicy/);
    const slow = {
      hook: 'cart.item.adding',
      name: 'x',
      failPolicy: 'open',
      timeoutMs: 400,
      handler: () => undefined,
    };
    expect(
      issuesOf({ ...base, performance: { hotPath: true }, interceptors: [slow] }).join(),
    ).toMatch(/timeoutMs/);
  });

  it('rejects unknown events, hooks, slots and services', () => {
    expect(
      issuesOf({
        ...base,
        observers: [{ event: 'order.exploded', name: 'a', handler: async () => undefined }],
      }).join(),
    ).toMatch(/unknown event/);
    expect(
      issuesOf({ ...base, slots: [{ slot: 'nowhere', id: 'a', component: lazy }] }).join(),
    ).toMatch(/unknown slot/);
    expect(
      issuesOf({
        ...base,
        services: [{ service: 'tax.calculator', key: 'a', create: () => ({}) }],
      }).join(),
    ).toMatch(/unknown service/);
  });

  it('rejects duplicates', () => {
    const obs = { event: 'order.placed' as const, name: 'send', handler: async () => undefined };
    expect(issuesOf({ ...base, observers: [obs, obs] }).join()).toMatch(/duplicate observer names/);
  });

  it('namespaces permissions and requires routes to declare them', () => {
    expect(
      issuesOf({ ...base, permissions: [{ key: 'other.points.adjust', description: 'x' }] }).join(),
    ).toMatch(/must start with "loyalty\."/);
    const route = {
      kind: 'api' as const,
      method: 'POST' as const,
      path: '/adjust',
      permission: 'loyalty.points.adjust',
      handler: async () => new Response(),
    };
    expect(issuesOf({ ...base, routes: [route] }).join()).toMatch(/not declared in permissions/);
    expect(() =>
      defineExtension({
        ...base,
        permissions: [{ key: 'loyalty.points.adjust', description: 'Adjust points' }],
        routes: [route],
      }),
    ).not.toThrow();
  });

  it('routes must be explicitly permissioned or public, never both or neither', () => {
    const r = {
      kind: 'api' as const,
      method: 'GET' as const,
      path: '/x',
      handler: async () => new Response(),
    };
    expect(issuesOf({ ...base, routes: [r] }).join()).toMatch(/exactly one/);
    expect(
      issuesOf({
        ...base,
        routes: [{ ...r, public: true, permission: 'base.orders.read' }],
      }).join(),
    ).toMatch(/exactly one/);
    expect(() => defineExtension({ ...base, routes: [{ ...r, public: true }] })).not.toThrow();
  });

  it('a route may be for signed-in customers, but only one audience at a time and never admin/webhook', () => {
    const r = {
      kind: 'api' as const,
      method: 'POST' as const,
      path: '/x',
      handler: async () => new Response(),
    };
    expect(() => defineExtension({ ...base, routes: [{ ...r, customer: true }] })).not.toThrow();
    expect(issuesOf({ ...base, routes: [{ ...r, customer: true, public: true }] }).join()).toMatch(
      /exactly one/,
    );
    expect(
      issuesOf({
        ...base,
        routes: [{ ...r, customer: true, permission: 'base.orders.read' }],
      }).join(),
    ).toMatch(/exactly one/);
    expect(issuesOf({ ...base, routes: [{ ...r, kind: 'admin', customer: true }] }).join()).toMatch(
      /storefront\/api routes only/,
    );
  });

  it('route response opt-outs are validated: a shared cache only on public GET routes', () => {
    const r = {
      kind: 'api' as const,
      method: 'GET' as const,
      path: '/x',
      public: true,
      handler: async () => new Response(),
    };
    expect(() =>
      defineExtension({
        ...base,
        routes: [
          { ...r, cache: { maxAgeSeconds: 60, scope: 'public' }, html: true, redirects: true },
        ],
      }),
    ).not.toThrow();
    expect(
      issuesOf({
        ...base,
        routes: [{ ...r, method: 'POST' as const, cache: { maxAgeSeconds: 60, scope: 'public' } }],
      }).join(),
    ).toMatch(/shared \(public\) cache/);
    expect(
      issuesOf({
        ...base,
        routes: [
          {
            ...r,
            public: undefined,
            permission: 'base.orders.read',
            cache: { maxAgeSeconds: 60, scope: 'public' },
          },
        ],
      }).join(),
    ).toMatch(/shared \(public\) cache/);
    expect(
      issuesOf({ ...base, routes: [{ ...r, cache: { maxAgeSeconds: 0 } }] }).length,
    ).toBeGreaterThan(0);
  });

  it('rejects the reserved job queue name that would collide with the observer queue', () => {
    const job = { queue: 'events', class: 'default' as const, handler: async () => undefined };
    expect(issuesOf({ ...base, jobs: [job] }).join()).toMatch(/queue name "events" is reserved/);
    expect(() =>
      defineExtension({ ...base, jobs: [{ ...job, queue: 'event-cleanup' }] }),
    ).not.toThrow();
  });

  it('webhooks must be public; admin routes must not be', () => {
    const hook = {
      kind: 'webhook' as const,
      method: 'POST' as const,
      path: '/hook',
      permission: 'base.orders.read',
      handler: async () => new Response(),
    };
    expect(issuesOf({ ...base, routes: [hook] }).join()).toMatch(/webhooks must be public/);
    const admin = {
      kind: 'admin' as const,
      method: 'GET' as const,
      path: '/x',
      public: true,
      handler: async () => new Response(),
    };
    expect(issuesOf({ ...base, routes: [admin] }).join()).toMatch(/admin routes cannot be public/);
  });

  it('rejects path traversal and malformed route paths', () => {
    for (const path of ['/../etc', 'relative', '/a//b', '/A b']) {
      const r = {
        kind: 'api' as const,
        method: 'GET' as const,
        path,
        public: true,
        handler: async () => new Response(),
      };
      expect(issuesOf({ ...base, routes: [r] }).length, path).toBeGreaterThan(0);
    }
  });

  it('validates settings: secrets must be fields; schema must parse an empty install', () => {
    const schema = z.object({ apiKey: z.string().default(''), rate: z.number().default(1) });
    expect(() =>
      defineExtension({ ...base, settings: { schema, secrets: ['apiKey'] } }),
    ).not.toThrow();
    expect(
      issuesOf({ ...base, settings: { schema, secrets: ['nope' as 'apiKey'] } }).join(),
    ).toMatch(/not a field/);
    expect(
      issuesOf({ ...base, settings: { schema: z.object({ required: z.string() }) } }).join(),
    ).toMatch(/default or to be optional/);
  });

  it('checks schedules reference jobs, and reporting views are single SELECTs', () => {
    expect(
      issuesOf({ ...base, schedules: [{ queue: 'nightly', cron: '0 3 * * *' }] }).join(),
    ).toMatch(/no matching job/);
    const view = (sql: string) => ({ name: 'points', description: 'd', sql });
    expect(() => defineExtension({ ...base, reportingViews: [view('SELECT 1')] })).not.toThrow();
    expect(issuesOf({ ...base, reportingViews: [view('DROP TABLE x')] }).join()).toMatch(
      /single SELECT/,
    );
    expect(issuesOf({ ...base, reportingViews: [view('SELECT 1; DROP TABLE x')] }).join()).toMatch(
      /single SELECT/,
    );
  });

  it('infers types through defineBlock and defineJob helpers', () => {
    const propsSchema = z.object({ title: z.string().default('Hi'), count: z.number().default(3) });
    const block = defineBlock({
      type: 'banner',
      title: 'Banner',
      propsSchema,
      defaultProps: {},
      component: lazy,
      thumbnail: 'data:,',
    });
    const job = defineJob({
      queue: 'sync',
      class: 'bulk',
      dataSchema: z.object({ customerId: z.string() }),
      handler: async ({ data }) => {
        const id: string = data.customerId;
        expect(typeof id).toBe('string');
      },
    });
    const m = defineExtension({
      ...base,
      blocks: [block],
      jobs: [job],
      schedules: [{ queue: 'sync', cron: '0 3 * * *' }],
    });
    expect(m.blocks[0]?.type).toBe('banner');
    expect(m.jobs[0]?.queue).toBe('sync');
  });
});
