import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from '@sold/extension-sdk';
import {
  discoverExtensions,
  DiscoveryError,
  type DiscoveredExtension,
} from '@sold/core/extensions/discovery';
import type { SoldConfig } from '@sold/core/config';
import type { CliContext } from '../lib/context';
import { CliError, ExitCode } from '../lib/errors';

export const DEFAULT_DOCS_PATH = 'docs/instance/extensions.md';

const code = (s: string) => `\`${s}\``;
const table = (head: string[], rows: string[][]) =>
  rows.length === 0
    ? '_None._\n'
    : [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map((c) => c.replaceAll('|', '\\|')).join(' | ')} |`),
        '',
      ].join('\n');

/** Reference for one extension, generated from its manifest so it can never drift from the code. */
export function renderExtensionReference(e: DiscoveredExtension): string {
  const m = e.manifest;
  const out: string[] = [];
  out.push(`## ${m.name}`, '');
  out.push(`${m.description || '_No description._'}`, '');
  out.push(
    table(
      ['Property', 'Value'],
      [
        ['Version', code(m.version)],
        ['Origin', e.origin],
        ['State', e.enabled ? 'enabled' : 'disabled'],
        ['Requires Base', code(m.requires.base)],
        [
          'Requires extensions',
          Object.entries(m.requires.extensions)
            .map(([n, r]) => `${code(n)} ${code(r)}`)
            .join(', ') || '-',
        ],
        [
          'Hot path',
          m.performance.hotPath ? `yes (budget ${m.performance.budgetMs} ms per call)` : 'no',
        ],
        ['Table prefix', code(m.tablePrefix)],
        ['Migrations', e.migrationFiles.length === 0 ? '-' : e.migrationFiles.map(code).join(', ')],
      ],
    ),
  );

  const fields = m.settings
    ? Object.entries(
        (
          z.toJSONSchema(m.settings.schema, { io: 'input', unrepresentable: 'any' }) as {
            properties?: Record<string, Record<string, unknown>>;
          }
        ).properties ?? {},
      )
    : [];
  out.push('### Settings', '');
  out.push(
    table(
      ['Key', 'Type', 'Default', 'Secret', 'Description'],
      fields.map(([k, p]) => [
        code(k),
        String(Array.isArray(p.type) ? p.type[0] : (p.type ?? 'string')),
        p.default === undefined ? '-' : code(JSON.stringify(p.default)),
        (m.settings?.secrets as readonly string[] | undefined)?.includes(k)
          ? 'yes (encrypted)'
          : 'no',
        String(p.description ?? p.title ?? ''),
      ]),
    ),
  );
  out.push(
    '### Permissions',
    '',
    table(
      ['Key', 'Description'],
      m.permissions.map((p) => [code(p.key), p.description]),
    ),
  );
  out.push(
    '### Observers',
    '',
    table(
      ['Event', 'Name'],
      m.observers.map((o) => [code(o.event), code(o.name)]),
    ),
  );
  out.push(
    '### Interceptors',
    '',
    table(
      ['Hook', 'Name', 'Order', 'Timeout', 'On failure'],
      m.interceptors.map((i) => [
        code(i.hook),
        code(i.name),
        String(i.order ?? 100),
        `${i.timeoutMs ?? m.performance.budgetMs} ms`,
        `fail ${i.failPolicy}`,
      ]),
    ),
  );
  out.push(
    '### Routes',
    '',
    table(
      ['Method', 'Path', 'Kind', 'Access'],
      m.routes.map((r) => [
        r.method,
        code(`${r.kind === 'admin' ? '/admin/x/' : '/x/'}${m.name}${r.path === '/' ? '' : r.path}`),
        r.kind,
        r.public ? 'public' : `permission ${code(r.permission ?? '')}`,
      ]),
    ),
  );
  out.push(
    '### Pages and admin screens',
    '',
    table(
      ['Kind', 'Path', 'Detail'],
      [
        ...m.pages.map((p) => [
          'storefront page',
          code(`/x/${m.name}${p.path}`),
          p.revalidate ? `ISR ${p.revalidate}s` : 'dynamic',
        ]),
        ...m.adminScreens.map((s) => [
          'admin screen',
          code(`/admin/x/${m.name}${s.path}`),
          `${s.title} (${code(s.permission)})`,
        ]),
      ],
    ),
  );
  out.push(
    '### Page-builder blocks',
    '',
    table(
      ['Type', 'Title'],
      m.blocks.map((b) => [code(`${m.name}/${b.type}`), b.title]),
    ),
  );
  out.push(
    '### UI slots',
    '',
    table(
      ['Slot', 'Id', 'Order'],
      m.slots.map((s) => [code(s.slot), code(s.id), String(s.order ?? 100)]),
    ),
  );
  out.push(
    '### Service providers',
    '',
    table(
      ['Service', 'Key'],
      m.services.map((p) => [code(p.service), code(p.key)]),
    ),
  );
  out.push(
    '### Jobs and schedules',
    '',
    table(
      ['Queue', 'Class', 'Schedule'],
      m.jobs.map((j) => [
        code(`ext.${m.name}.${j.queue}`),
        j.class,
        m.schedules
          .filter((s) => s.queue === j.queue)
          .map((s) => code(s.cron))
          .join(', ') || '-',
      ]),
    ),
  );
  out.push(
    '### Reporting views',
    '',
    table(
      ['View', 'Description'],
      m.reportingViews.map((v) => [code(`reporting.${m.tablePrefix}${v.name}`), v.description]),
    ),
  );
  return out.join('\n');
}

/** `sold ext:docs`: write the extension reference for this instance (customer-owned path by default). */
export async function extDocs(
  ctx: CliContext,
  options: { out?: string; loadConfig?: () => Promise<SoldConfig> } = {},
): Promise<string> {
  try {
    const found = await discoverExtensions(ctx.cwd, options.loadConfig);
    const body = [
      '# Extension reference',
      '',
      '_Generated by `pnpm sold ext:docs` from the extension manifests. Do not edit by hand._',
      '',
      ...(found.extensions.length === 0
        ? ['No extensions are configured.', '']
        : found.extensions.map(renderExtensionReference)),
    ].join('\n');
    const path = join(ctx.cwd, options.out ?? DEFAULT_DOCS_PATH);
    if (!ctx.dryRun) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    ctx.out.info(
      `${ctx.dryRun ? 'would write' : 'wrote'} ${options.out ?? DEFAULT_DOCS_PATH} (${found.extensions.length} extension(s))`,
    );
    return body;
  } catch (error) {
    if (error instanceof DiscoveryError) throw new CliError(error.message, ExitCode.failure);
    throw error;
  }
}
