import semver from 'semver';
import { z } from 'zod';
import type { ExtensionContext, InterceptorContext, RouteContext } from './context';
import { tablePrefix } from './db';
import {
  hotPathHooks,
  type EventName,
  type HookName,
  type InterceptorDefinition,
  type ObserverDefinition,
} from './events';
import type { LazyComponent, SlotContribution, SlotName } from './slots';
import type { ServiceName, ServiceProvider } from './services';

export type SettingsSchema = z.ZodObject<z.ZodRawShape>;

export interface SettingsDefinition<S extends SettingsSchema = SettingsSchema> {
  /** Zod schema for the settings form. Every field needs a default or to be optional so a fresh install parses. */
  schema: S;
  /** Top-level keys stored envelope-encrypted; never sent back to the admin UI in clear text. */
  secrets?: readonly (keyof z.output<S> & string)[];
}

export interface PermissionDefinition {
  /** Must start with `<extension name>.`, e.g. `loyalty.points.adjust`. Shown in the admin role editor. */
  key: string;
  description: string;
}

export type ObserverOf<C> = { [E in EventName]: ObserverDefinition<E, C> }[EventName];
export type InterceptorOf<C> = { [H in HookName]: InterceptorDefinition<H, C> }[HookName];
export type SlotOf = { [K in SlotName]: SlotContribution<K> }[SlotName];
export type ProviderOf = { [K in ServiceName]: ServiceProvider<K> }[ServiceName];

export interface BlockDefinition {
  /** Unique within the extension; the page-builder type is `<extension>/<type>`. */
  type: string;
  title: string;
  description?: string;
  category?: string;
  /** Validates block props when a page is saved and again when it is rendered. */
  propsSchema: z.ZodType<object>;
  defaultProps: object;
  /** Server-rendered. Must not pull builder or editor code into the storefront bundle. */
  component: LazyComponent<never>;
  /** Optional custom editor; otherwise a form is generated from `propsSchema`. */
  editor?: LazyComponent<never>;
  /** URL or data URI of a preview thumbnail for the block picker. */
  thumbnail: string;
}

export interface RouteDefinition<C = RouteContext> {
  kind: 'api' | 'webhook' | 'storefront' | 'admin';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Relative to `/x/<extension>` (storefront/api/webhook) or `/admin/x/<extension>` (admin). Params: `:id`. */
  path: string;
  /** Permission checked through `authorize()`. Exactly one of `permission` or `public: true`. */
  permission?: string;
  /** Explicitly unauthenticated. Required (and only allowed) for webhooks, which verify their own signature. */
  public?: boolean;
  handler(request: Request, ctx: C & { params: Record<string, string> }): Promise<Response>;
}

export interface PageDefinition {
  /** Storefront page under `/x/<extension>`. */
  path: string;
  component: LazyComponent<never>;
  /** ISR seconds; omit for fully dynamic. Public pages should be cacheable (Section 8A.2). */
  revalidate?: number;
}

export interface AdminScreenDefinition {
  path: string;
  title: string;
  permission: string;
  component: LazyComponent<never>;
  nav?: { section: string; order?: number };
}

export interface JobDefinition<C = ExtensionContext> {
  /** Local queue name; the real queue is `ext.<extension>.<queue>`. */
  queue: string;
  class: 'critical' | 'default' | 'bulk';
  dataSchema?: z.ZodType<object>;
  handler(job: { id: string; data: never; retryCount: number }, ctx: C): Promise<void>;
}

export interface ScheduleDefinition {
  queue: string;
  cron: string;
  data?: object;
}

export interface ReportingViewDefinition {
  /** Becomes `reporting.ext_<extension>_<name>`. The view contract is semver-major to break (docs). */
  name: string;
  description: string;
  /** A single SELECT. */
  sql: string;
}

export interface LifecycleHooks<C = ExtensionContext> {
  /** First time the extension is seen on this instance, after its migrations ran. */
  onInstall?(ctx: C): Promise<void>;
  onEnable?(ctx: C): Promise<void>;
  onDisable?(ctx: C): Promise<void>;
  /** Only via an explicit purge (`sold ext:uninstall --purge`). Never automatic. */
  onUninstall?(ctx: C): Promise<void>;
}

export interface PerformanceContract {
  /** Whether this extension has interceptors on cart/checkout. Declared honestly: Base enforces it. */
  hotPath: boolean;
  /** Time budget per hot-path interceptor call, in ms (1..50). Default 10. */
  budgetMs?: number;
}

export interface ExtensionDefinition<S extends SettingsSchema = SettingsSchema> {
  /** kebab-case, 2..31 chars. Also the table prefix (`ext_<name>_`), route prefix and permission namespace. */
  name: string;
  version: string;
  description?: string;
  /** Load-time compatibility: `base` is a semver range against the Base version. */
  requires: { base: string; extensions?: Record<string, string> };
  performance: PerformanceContract;
  /** Directory of forward-only SQL migrations, relative to the extension package root. */
  migrations?: { dir: string };
  settings?: SettingsDefinition<S>;
  permissions?: readonly PermissionDefinition[];
  observers?: readonly ObserverOf<ExtensionContext<z.output<S>>>[];
  interceptors?: readonly InterceptorOf<InterceptorContext<z.output<S>>>[];
  blocks?: readonly BlockDefinition[];
  slots?: readonly SlotOf[];
  routes?: readonly RouteDefinition<RouteContext<z.output<S>>>[];
  pages?: readonly PageDefinition[];
  adminScreens?: readonly AdminScreenDefinition[];
  services?: readonly ProviderOf[];
  jobs?: readonly JobDefinition<ExtensionContext<z.output<S>>>[];
  schedules?: readonly ScheduleDefinition[];
  reportingViews?: readonly ReportingViewDefinition[];
  lifecycle?: LifecycleHooks<ExtensionContext<z.output<S>>>;
}

/** What Base consumes: settings-typed contexts are erased, because Base hands over the real context. */
export interface ExtensionManifest {
  readonly __soldExtension: true;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly requires: { base: string; extensions: Readonly<Record<string, string>> };
  readonly performance: { hotPath: boolean; budgetMs: number };
  readonly tablePrefix: string;
  readonly migrations: { dir: string } | null;
  readonly settings: SettingsDefinition | null;
  readonly permissions: readonly PermissionDefinition[];
  readonly observers: readonly ObserverOf<never>[];
  readonly interceptors: readonly InterceptorOf<never>[];
  readonly blocks: readonly BlockDefinition[];
  readonly slots: readonly SlotOf[];
  readonly routes: readonly RouteDefinition<never>[];
  readonly pages: readonly PageDefinition[];
  readonly adminScreens: readonly AdminScreenDefinition[];
  readonly services: readonly ProviderOf[];
  readonly jobs: readonly JobDefinition<never>[];
  readonly schedules: readonly ScheduleDefinition[];
  readonly reportingViews: readonly ReportingViewDefinition[];
  readonly lifecycle: LifecycleHooks<never>;
}

export class ManifestError extends Error {
  constructor(
    public readonly extension: string,
    public readonly issues: string[],
  ) {
    super(
      `Invalid extension manifest "${extension}":\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'ManifestError';
  }
}

/** Names that would collide with Base concepts or routes. */
export const reservedExtensionNames = [
  'sold',
  'base',
  'core',
  'admin',
  'api',
  'x',
  'template',
  'sdk',
] as const;

const isFn = z.custom<(...args: never[]) => unknown>(
  (v) => typeof v === 'function',
  'must be a function',
);
const identifier = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lower-case kebab-case');

const shapeSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,30}$/, '2-31 chars, lower-case kebab-case, starting with a letter'),
  version: z.string().refine((v) => semver.valid(v) !== null, 'must be a valid semver version'),
  description: z.string().max(500).optional(),
  requires: z.object({
    base: z.string().refine((v) => semver.validRange(v) !== null, 'must be a valid semver range'),
    extensions: z
      .record(
        z.string(),
        z.string().refine((v) => semver.validRange(v) !== null, 'must be a valid semver range'),
      )
      .optional(),
  }),
  performance: z.object({
    hotPath: z.boolean(),
    budgetMs: z.number().int().min(1).max(50).optional(),
  }),
  migrations: z.object({ dir: z.string().min(1) }).optional(),
  permissions: z
    .array(z.object({ key: z.string().min(1), description: z.string().min(1) }))
    .optional(),
  observers: z.array(z.object({ event: z.string(), name: identifier, handler: isFn })).optional(),
  interceptors: z
    .array(
      z.object({
        hook: z.string(),
        name: identifier,
        order: z.number().int().optional(),
        timeoutMs: z.number().int().min(1).max(50).optional(),
        failPolicy: z.enum(['open', 'closed']),
        handler: isFn,
      }),
    )
    .optional(),
  blocks: z
    .array(
      z.object({
        type: identifier,
        title: z.string().min(1),
        thumbnail: z.string().min(1),
        component: isFn,
      }),
    )
    .optional(),
  slots: z.array(z.object({ slot: z.string(), id: identifier, component: isFn })).optional(),
  routes: z
    .array(
      z.object({
        kind: z.enum(['api', 'webhook', 'storefront', 'admin']),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string(),
        permission: z.string().optional(),
        public: z.boolean().optional(),
        handler: isFn,
      }),
    )
    .optional(),
  pages: z
    .array(
      z.object({
        path: z.string(),
        component: isFn,
        revalidate: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  adminScreens: z
    .array(
      z.object({
        path: z.string(),
        title: z.string().min(1),
        permission: z.string().min(1),
        component: isFn,
      }),
    )
    .optional(),
  services: z.array(z.object({ service: z.string(), key: identifier, create: isFn })).optional(),
  jobs: z
    .array(
      z.object({
        queue: identifier,
        class: z.enum(['critical', 'default', 'bulk']),
        handler: isFn,
      }),
    )
    .optional(),
  schedules: z.array(z.object({ queue: identifier, cron: z.string().min(9) })).optional(),
  reportingViews: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case'),
        description: z.string().min(1),
        sql: z.string().min(1),
      }),
    )
    .optional(),
});

const KNOWN_EVENTS = new Set<string>([
  'cart.updated',
  'order.placed',
  'payment.captured',
  'order.status_changed',
]);
const KNOWN_HOOKS = new Set<string>(['cart.item.adding', 'checkout.placing']);
const KNOWN_SLOTS = new Set<string>([
  'storefront.header.end',
  'storefront.footer',
  'product.detail.aside',
  'cart.summary.footer',
  'checkout.summary.footer',
  'account.dashboard',
  'admin.dashboard.widgets',
  'admin.order.actions',
  'admin.product.editor.sidebar',
]);
const KNOWN_SERVICES = new Set<string>(['pricing.rounding']);

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

/**
 * Declare an extension. Validates everything that can be validated without running Base, so a bad
 * manifest fails at import time with every problem listed, not one at a time in production.
 *
 * The returned manifest is deeply frozen at the top level and safe to share.
 */
export function defineExtension<S extends SettingsSchema = SettingsSchema>(
  def: ExtensionDefinition<S>,
): ExtensionManifest {
  const label = typeof def?.name === 'string' ? def.name : '(unnamed)';
  const issues: string[] = [];

  const parsed = shapeSchema.safeParse(def);
  if (!parsed.success) {
    for (const i of parsed.error.issues)
      issues.push(`${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ManifestError(label, issues);
  }

  const name = def.name;
  if ((reservedExtensionNames as readonly string[]).includes(name))
    issues.push(`name "${name}" is reserved`);

  const hotPath = def.performance.hotPath;
  const interceptors = def.interceptors ?? [];
  for (const i of interceptors) {
    if (!KNOWN_HOOKS.has(i.hook)) issues.push(`interceptors.${i.name}: unknown hook "${i.hook}"`);
    if ((hotPathHooks as readonly string[]).includes(i.hook) && !hotPath) {
      issues.push(
        `interceptors.${i.name}: hook "${i.hook}" is on the cart/checkout hot path, so performance.hotPath must be true`,
      );
    }
  }
  if (hotPath && interceptors.length === 0) {
    issues.push(
      'performance.hotPath is true but the extension has no interceptors: declare hotPath only when it is true',
    );
  }
  for (const o of def.observers ?? [])
    if (!KNOWN_EVENTS.has(o.event)) issues.push(`observers.${o.name}: unknown event "${o.event}"`);
  for (const s of def.slots ?? [])
    if (!KNOWN_SLOTS.has(s.slot)) issues.push(`slots.${s.id}: unknown slot "${s.slot}"`);
  for (const p of def.services ?? [])
    if (!KNOWN_SERVICES.has(p.service))
      issues.push(`services.${p.key}: unknown service "${p.service}"`);

  const dupChecks: [string, string[]][] = [
    ['observer names', (def.observers ?? []).map((o) => o.name)],
    ['interceptor names', interceptors.map((i) => i.name)],
    ['block types', (def.blocks ?? []).map((b) => b.type)],
    ['slot contribution ids', (def.slots ?? []).map((s) => s.id)],
    ['routes', (def.routes ?? []).map((r) => `${r.method} ${r.path}`)],
    ['job queues', (def.jobs ?? []).map((j) => j.queue)],
    ['service providers', (def.services ?? []).map((p) => `${p.service}/${p.key}`)],
    ['permission keys', (def.permissions ?? []).map((p) => p.key)],
    ['reporting views', (def.reportingViews ?? []).map((v) => v.name)],
  ];
  for (const [what, list] of dupChecks)
    for (const d of duplicates(list)) issues.push(`duplicate ${what}: ${d}`);

  const permissionKeys = new Set((def.permissions ?? []).map((p) => p.key));
  for (const p of def.permissions ?? []) {
    if (!new RegExp(`^${name.replaceAll('-', '\\-')}\\.[a-z0-9_.-]+$`).test(p.key)) {
      issues.push(`permissions.${p.key}: must start with "${name}."`);
    }
  }

  for (const r of def.routes ?? []) {
    const where = `routes ${r.method} ${r.path}`;
    if (!r.path.startsWith('/') || r.path.includes('..') || r.path.includes('//'))
      issues.push(`${where}: path must start with "/" and contain no ".." or "//"`);
    if (!/^(\/([a-z0-9_-]+|:[a-zA-Z][a-zA-Z0-9]*))*\/?$/.test(r.path) && r.path !== '/')
      issues.push(`${where}: path segments must be [a-z0-9_-] or :param`);
    const hasPerm = typeof r.permission === 'string';
    if (hasPerm === (r.public === true))
      issues.push(`${where}: declare exactly one of "permission" or "public: true"`);
    if (r.kind === 'webhook' && r.public !== true)
      issues.push(`${where}: webhooks must be public (they verify their own signature)`);
    if (r.public === true && r.kind === 'admin')
      issues.push(`${where}: admin routes cannot be public`);
    if (
      hasPerm &&
      !permissionKeys.has(r.permission as string) &&
      !(r.permission as string).startsWith('base.')
    ) {
      issues.push(
        `${where}: permission "${r.permission}" is not declared in permissions (or a base.* permission)`,
      );
    }
  }
  for (const s of def.adminScreens ?? []) {
    if (!permissionKeys.has(s.permission) && !s.permission.startsWith('base.')) {
      issues.push(
        `adminScreens ${s.path}: permission "${s.permission}" is not declared in permissions`,
      );
    }
  }

  const secretKeys = def.settings?.secrets ?? [];
  const shapeKeys = def.settings ? Object.keys(def.settings.schema.shape) : [];
  for (const k of secretKeys)
    if (!shapeKeys.includes(k))
      issues.push(`settings.secrets: "${k}" is not a field of the settings schema`);
  if (def.settings) {
    const empty = def.settings.schema.safeParse({});
    if (!empty.success)
      issues.push(
        'settings.schema: every field needs a default or to be optional, so a fresh install parses',
      );
  }

  const localQueues = new Set((def.jobs ?? []).map((j) => j.queue));
  for (const s of def.schedules ?? [])
    if (!localQueues.has(s.queue)) issues.push(`schedules: queue "${s.queue}" has no matching job`);

  for (const v of def.reportingViews ?? []) {
    const sql = v.sql.trim();
    if (!/^(select|with)\b/i.test(sql) || sql.includes(';'))
      issues.push(`reportingViews.${v.name}: must be a single SELECT statement with no ";"`);
  }

  for (const dep of Object.keys(def.requires.extensions ?? {})) {
    if (dep === name) issues.push('requires.extensions: an extension cannot require itself');
  }

  if (issues.length > 0) throw new ManifestError(name, issues);

  // The definition's handler types are specific to this extension's settings; Base only ever calls
  // them with the real context, so the manifest erases them. This is the single, deliberate cast.
  const erased = def as unknown as Pick<
    ExtensionManifest,
    'observers' | 'interceptors' | 'routes' | 'jobs' | 'lifecycle' | 'settings'
  > &
    ExtensionDefinition;

  const manifest: ExtensionManifest = {
    __soldExtension: true,
    name,
    version: def.version,
    description: def.description ?? '',
    requires: {
      base: def.requires.base,
      extensions: Object.freeze({ ...(def.requires.extensions ?? {}) }),
    },
    performance: { hotPath, budgetMs: def.performance.budgetMs ?? 10 },
    tablePrefix: tablePrefix(name),
    migrations: def.migrations ?? null,
    settings: (erased.settings as SettingsDefinition | undefined) ?? null,
    permissions: def.permissions ?? [],
    observers: erased.observers ?? [],
    interceptors: erased.interceptors ?? [],
    blocks: def.blocks ?? [],
    slots: def.slots ?? [],
    routes: erased.routes ?? [],
    pages: def.pages ?? [],
    adminScreens: def.adminScreens ?? [],
    services: def.services ?? [],
    jobs: erased.jobs ?? [],
    schedules: def.schedules ?? [],
    reportingViews: def.reportingViews ?? [],
    lifecycle: erased.lifecycle ?? {},
  };
  return Object.freeze(manifest);
}

export function isExtensionManifest(value: unknown): value is ExtensionManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __soldExtension?: unknown }).__soldExtension === true
  );
}

// ---- inference helpers: erase generics so heterogeneous items can share one array ----------------

/** Define a page-builder block with props inferred from its schema. */
export function defineBlock<S extends z.ZodObject>(def: {
  type: string;
  title: string;
  description?: string;
  category?: string;
  propsSchema: S;
  defaultProps: z.input<S>;
  component: LazyComponent<z.output<S>>;
  editor?: LazyComponent<{ value: z.output<S>; onChange(next: z.output<S>): void }>;
  thumbnail: string;
}): BlockDefinition {
  // `LazyComponent<P>` is assignable to `LazyComponent<never>`; the schema-typed props are checked here at the call site.
  return def as unknown as BlockDefinition;
}

/** Define a job whose `data` type is inferred from its schema. */
export function defineJob<S extends z.ZodType<object>, C = ExtensionContext>(def: {
  queue: string;
  class: 'critical' | 'default' | 'bulk';
  dataSchema: S;
  handler(job: { id: string; data: z.output<S>; retryCount: number }, ctx: C): Promise<void>;
}): JobDefinition<C> {
  return def as unknown as JobDefinition<C>;
}
