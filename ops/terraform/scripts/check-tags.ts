/**
 * Fails when any taggable Azure resource in a Terraform plan lacks a mandatory `sold:*` tag.
 *
 *   terraform plan -out=tfplan && terraform show -json tfplan > plan.json
 *   pnpm exec tsx ops/terraform/scripts/check-tags.ts plan.json [--env-id demo-dev]
 *
 * A resource is "taggable" when its planned `after` object has a `tags` key (Terraform includes
 * every schema attribute, null when unset), so the check needs no per-resource-type allow-list and
 * cannot silently skip a resource type it has never heard of. Tags whose *values* are only known
 * after apply are accepted as long as the key is present; a wholly-unknown `tags` map is rejected
 * because it cannot be proven compliant at plan time.
 *
 * Dependency-free on purpose: it runs in CI before `pnpm install` finishes for other packages.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REQUIRED_TAGS = [
  'sold:customer',
  'sold:environment',
  'sold:profile',
  'sold:owner',
  'sold:expires-at',
  'sold:release',
  'sold:env-id',
] as const;

export interface PlanResourceChange {
  address: string;
  mode?: string;
  type: string;
  change: {
    actions: string[];
    after?: Record<string, unknown> | null;
    after_unknown?: Record<string, unknown> | null;
  };
}

export interface TerraformPlan {
  resource_changes?: PlanResourceChange[];
}

export interface TagViolation {
  address: string;
  type: string;
  /** Required tag keys that are absent. */
  missing: string[];
  /** Required tag keys that are present but empty. */
  empty: string[];
  /** Required tag keys whose value differs from the expected env-id. */
  wrongEnvId: boolean;
  /** The whole tags map is unknown until apply, or null. */
  reason?: 'no-tags' | 'tags-unknown';
}

export interface TagCheckResult {
  checked: number;
  skippedNotTaggable: number;
  violations: TagViolation[];
}

export interface TagCheckOptions {
  /** When set, `sold:env-id` must equal this on every taggable resource (what `env:down --verify` relies on). */
  envId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkPlanTags(plan: TerraformPlan, options: TagCheckOptions = {}): TagCheckResult {
  const result: TagCheckResult = { checked: 0, skippedNotTaggable: 0, violations: [] };

  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode !== undefined && rc.mode !== 'managed') continue;
    if (!rc.type.startsWith('azurerm_')) continue;
    const actions = rc.change.actions;
    // Resources that are only being destroyed do not need tags.
    if (actions.length === 1 && actions[0] === 'delete') continue;

    const after = rc.change.after;
    if (!isRecord(after) || !('tags' in after)) {
      result.skippedNotTaggable += 1;
      continue;
    }
    result.checked += 1;

    const violation: TagViolation = {
      address: rc.address,
      type: rc.type,
      missing: [],
      empty: [],
      wrongEnvId: false,
    };

    const unknown = rc.change.after_unknown;
    const tagsUnknown = isRecord(unknown) ? unknown['tags'] : undefined;
    const tags = after['tags'];

    if (tagsUnknown === true) {
      violation.reason = 'tags-unknown';
    } else if (!isRecord(tags) && !isRecord(tagsUnknown)) {
      violation.reason = 'no-tags';
    } else {
      const known = isRecord(tags) ? tags : {};
      const unknownKeys = isRecord(tagsUnknown) ? tagsUnknown : {};
      for (const key of REQUIRED_TAGS) {
        const value = known[key];
        const present = key in known || unknownKeys[key] === true;
        if (!present) {
          violation.missing.push(key);
        } else if (key in known && (typeof value !== 'string' || value.trim() === '')) {
          violation.empty.push(key);
        }
      }
      if (
        options.envId !== undefined &&
        typeof known['sold:env-id'] === 'string' &&
        known['sold:env-id'] !== options.envId
      ) {
        violation.wrongEnvId = true;
      }
    }

    if (
      violation.reason !== undefined ||
      violation.missing.length > 0 ||
      violation.empty.length > 0 ||
      violation.wrongEnvId
    ) {
      result.violations.push(violation);
    }
  }

  return result;
}

export function formatViolations(result: TagCheckResult): string {
  const lines = [
    `Checked ${result.checked} taggable Azure resource(s); ${result.skippedNotTaggable} not taggable.`,
  ];
  if (result.violations.length === 0) {
    lines.push('OK: every taggable Azure resource carries all mandatory sold:* tags.');
    return lines.join('\n');
  }
  lines.push(`FAIL: ${result.violations.length} resource(s) violate the tagging policy:`);
  for (const v of result.violations) {
    const parts: string[] = [];
    if (v.reason === 'no-tags') parts.push('tags is null/empty');
    if (v.reason === 'tags-unknown') parts.push('tags are unknown until apply');
    if (v.missing.length > 0) parts.push(`missing: ${v.missing.join(', ')}`);
    if (v.empty.length > 0) parts.push(`empty: ${v.empty.join(', ')}`);
    if (v.wrongEnvId) parts.push('sold:env-id does not match the expected environment');
    lines.push(`  - ${v.address} (${v.type}): ${parts.join('; ')}`);
  }
  return lines.join('\n');
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  let file: string | undefined;
  let envId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--env-id') {
      envId = args[i + 1];
      i += 1;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      file = arg;
    }
  }
  if (file === undefined) {
    console.error(
      'usage: check-tags.ts <plan.json> [--env-id <id>]   (plan.json from `terraform show -json`)',
    );
    return 2;
  }
  // The JSON is produced by `terraform show -json`; the structural checks above tolerate anything else.
  const plan = JSON.parse(readFileSync(file, 'utf8')) as TerraformPlan;
  const result = checkPlanTags(plan, envId === undefined ? {} : { envId });
  console.log(formatViolations(result));
  return result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
