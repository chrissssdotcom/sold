import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TEMPLATE_ROOT = fileURLToPath(new URL('../../templates/', import.meta.url));

export async function readTemplate(relativePath: string): Promise<string> {
  return readFile(`${TEMPLATE_ROOT}${relativePath}`, 'utf8');
}

/**
 * `{{key}}` substitution. A line that consists only of a placeholder whose value is empty is removed
 * entirely (so optional blocks leave no blank lines). Unknown keys throw: a typo must not ship.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const out: string[] = [];
  for (const line of template.split('\n')) {
    const solo = /^\s*\{\{(\w+)\}\}\s*$/.exec(line);
    if (solo?.[1] !== undefined && values[solo[1]] === '') continue;
    out.push(
      line.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        const value = values[key];
        if (value === undefined) throw new Error(`template placeholder {{${key}}} has no value`);
        return value;
      }),
    );
  }
  return out.join('\n');
}

export type TerraformEnvironmentName = 'dev' | 'stage' | 'prod' | 'ephemeral';

export interface TerraformScaffoldInput {
  customer: string;
  environment: TerraformEnvironmentName;
  /** Globally unique storage account holding this customer's Terraform state. */
  stateAccount?: string;
  registryName?: string;
}

export function defaultStateAccount(customer: string): string {
  return `stsold${customer}tfstate`.slice(0, 24);
}

export function defaultRegistryName(customer: string): string {
  return `acrsold${customer}`;
}

/** Files (relative to `ops/terraform/environments/<customer>/<environment>/`) of one Terraform root module. */
export async function renderTerraformEnvironment(
  input: TerraformScaffoldInput,
): Promise<Record<string, string>> {
  const { customer, environment } = input;
  const stateAccount = input.stateAccount ?? defaultStateAccount(customer);
  const registryName = input.registryName ?? defaultRegistryName(customer);
  const kind = environment === 'ephemeral' ? 'ephemeral' : 'persistent';
  const prod = environment === 'prod';
  const usesTier = environment === 'stage' || prod;

  const varFiles = usesTier
    ? [
        `#     -var-file=../../../profiles/${environment}.tfvars \\`,
        '#     -var-file=../../../profiles/tier-standard.tfvars   # capacity from the tier (see sold.config.ts)',
      ].join('\n')
    : `#     -var-file=../../../profiles/${environment}.tfvars   # profile_settings + capacity`;

  const values: Record<string, string> = {
    customer,
    environment,
    profile: environment,
    state_account: stateAccount,
    state_container: prod ? 'tfstate-prod' : 'tfstate',
    registry_name: registryName,
    purge_on_destroy: prod ? 'false' : 'true',
    key_vault_comment: prod
      ? '      # Production: never purge on destroy; purge protection is on and prevent_destroy guards the vault.'
      : '      # Non-prod: purge on destroy so the vault name is released immediately (soft-delete reserves it otherwise).',
    var_files_comment: varFiles,
    var_files_inline: usesTier
      ? `-var-file=../../../profiles/${environment}.tfvars and -var-file=../../../profiles/tier-<tier>.tfvars`
      : `-var-file=../../../profiles/${environment}.tfvars`,
    subscription_description: prod
      ? 'Customer Azure subscription for production (separate from non-production).'
      : 'Customer Azure subscription for non-production.',
    tier_line: usesTier ? 'tier            = "standard"' : '',
    hostname: prod ? `shop.${customer}.example` : `${environment}.${customer}.example`,
    access_block: prod
      ? '# Production is public: Cloudflare Access protects non-production environments only.\naccess = {\n  enabled = false\n}'
      : `access = {\n  enabled               = true\n  allowed_email_domains = ["${customer}.example"]\n}`,
  };
  const files: Record<string, string> = {};
  const names: [string, string][] = [
    ['versions.tf', `terraform/versions.${kind}.tf.tpl`],
    ['main.tf', `terraform/main.${kind}.tf.tpl`],
    ['variables.tf', `terraform/variables.${kind}.tf.tpl`],
    ['outputs.tf', `terraform/outputs.${kind}.tf.tpl`],
    ['terraform.tfvars', `terraform/terraform.tfvars.${kind}.tpl`],
  ];
  for (const [file, template] of names) {
    files[file] = renderTemplate(await readTemplate(template), values);
  }
  return files;
}
