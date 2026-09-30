import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIRED_TAGS, checkPlanTags, formatViolations, type TerraformPlan } from './check-tags';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name: string): TerraformPlan =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8')) as TerraformPlan;

describe('check-tags', () => {
  it('requires exactly the seven mandatory tags', () => {
    expect([...REQUIRED_TAGS]).toEqual([
      'sold:customer',
      'sold:environment',
      'sold:profile',
      'sold:owner',
      'sold:expires-at',
      'sold:release',
      'sold:env-id',
    ]);
  });

  it('passes a compliant plan (tags present, unknown values allowed, non-taggable and destroyed resources ignored)', () => {
    const result = checkPlanTags(load('plan-compliant.json'), { envId: 'demo-dev' });
    expect(result.violations).toEqual([]);
    expect(result.checked).toBe(3); // resource group, key vault, container app
    expect(result.skippedNotTaggable).toBe(2); // role assignment, management lock
  });

  it('ignores non-azurerm resources such as Cloudflare records', () => {
    const result = checkPlanTags(load('plan-compliant.json'));
    expect(result.violations.map((v) => v.type)).not.toContain('cloudflare_dns_record');
  });

  it('flags every kind of violation in the bad fixture', () => {
    const result = checkPlanTags(load('plan-violations.json'), { envId: 'demo-dev' });
    const byType = Object.fromEntries(result.violations.map((v) => [v.type, v]));

    expect(byType['azurerm_postgresql_flexible_server']?.missing).toEqual(['sold:owner']);
    expect(byType['azurerm_managed_redis']?.reason).toBe('no-tags');
    expect(byType['azurerm_virtual_network']?.empty).toEqual(['sold:expires-at']);
    expect(byType['azurerm_log_analytics_workspace']?.reason).toBe('tags-unknown');
    expect(byType['azurerm_application_insights']?.wrongEnvId).toBe(true);

    // Compliant resource group and non-taggable subnet are not reported.
    expect(byType['azurerm_resource_group']).toBeUndefined();
    expect(byType['azurerm_subnet']).toBeUndefined();
    expect(result.violations).toHaveLength(5);
  });

  it('only enforces the env-id value when one is expected', () => {
    const result = checkPlanTags(load('plan-violations.json'));
    const insights = result.violations.find((v) => v.type === 'azurerm_application_insights');
    expect(insights).toBeUndefined();
  });

  it('treats a resource that is only being destroyed as exempt but checks replacements', () => {
    const plan: TerraformPlan = {
      resource_changes: [
        {
          address: 'azurerm_resource_group.gone',
          type: 'azurerm_resource_group',
          mode: 'managed',
          change: { actions: ['delete'], after: null },
        },
        {
          address: 'azurerm_resource_group.replaced',
          type: 'azurerm_resource_group',
          mode: 'managed',
          change: { actions: ['delete', 'create'], after: { tags: {} } },
        },
      ],
    };
    const result = checkPlanTags(plan);
    expect(result.violations.map((v) => v.address)).toEqual(['azurerm_resource_group.replaced']);
    expect(result.violations[0]?.missing).toHaveLength(REQUIRED_TAGS.length);
  });

  it('formats a readable report', () => {
    expect(formatViolations(checkPlanTags(load('plan-compliant.json')))).toContain('OK:');
    const report = formatViolations(checkPlanTags(load('plan-violations.json')));
    expect(report).toContain('FAIL: 4 resource(s)');
    expect(report).toContain('module.environment.module.redis[0].azurerm_managed_redis.this');
    expect(report).toContain('missing: sold:owner');
  });
});
