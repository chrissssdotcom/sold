# Root module for {{customer}}/{{environment}}. Thin by design: it wires providers and the release, then delegates to
# the sold-environment composite. Everything that differs between environments is data:
#   terraform apply \
{{var_files_comment}}
# and terraform.tfvars (customer-specific, non-secret).

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true

  features {
    key_vault {
{{key_vault_comment}}
      purge_soft_delete_on_destroy    = {{purge_on_destroy}}
      recover_soft_deleted_key_vaults = true
    }
  }
}

# Token from CLOUDFLARE_API_TOKEN (never in files).
provider "cloudflare" {}

locals {
  customer    = "{{customer}}"
  environment = "{{environment}}"
  env_id      = "${local.customer}-${local.environment}"

  # Promoted, immutable release for this environment. Changed only by a promotion PR.
  release_file = jsondecode(file("${path.module}/../../../../../environments/{{environment}}/release.json"))
  release = {
    version       = "${local.release_file.baseVersion}+${local.customer}.${local.release_file.instanceBuild}"
    image         = "${var.registry.login_server}/sold/web@${local.release_file.imageDigest}"
    worker_image  = try("${var.registry.login_server}/sold/worker@${local.release_file.workerImageDigest}", null)
    migrate_image = try("${var.registry.login_server}/sold/migrate@${local.release_file.migrateImageDigest}", null)
  }
}

module "environment" {
  source = "../../../modules/sold-environment"

  customer    = local.customer
  environment = local.environment
  env_id      = local.env_id
  profile     = "{{profile}}"
  tier        = var.tier
  region      = var.region
  release     = local.release
  owner       = var.owner
  expires_at  = "never"

  profile_settings = var.profile_settings
  tier_settings    = var.tier_settings

  registry     = var.registry
  cloudflare   = var.cloudflare
  access       = var.access
  email        = var.email
  alert_emails = var.alert_emails

  paused = var.paused

  # Driven by the release pipeline (`sold release:deploy`): canary traffic split between revisions.
  canary_percent           = var.canary_percent
  previous_revision_suffix = var.previous_revision_suffix

  drift_reader_object_id = var.drift_reader_object_id
}
