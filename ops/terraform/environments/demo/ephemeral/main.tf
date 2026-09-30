# Root module for demo ephemeral (preview) environments. One root, many states (see versions.tf).
#   terraform init  -backend-config="key=ephemeral/<env-id>.tfstate"
#   terraform apply -var-file=../../../profiles/ephemeral.tfvars \
#     -var env_id=<env-id> -var environment=<name> -var owner=<who> -var expires_at=<RFC3339> \
#     -var release_version=<base>+demo.<build> -var image=<registry>/sold/web@sha256:<digest>

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true

  features {
    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      # Ephemeral environments own their resource group outright: destroying it must never be
      # blocked by resources created outside Terraform, or `env:down --verify` would fail on leftovers.
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "cloudflare" {}

locals {
  customer = "demo"
}

module "environment" {
  source = "../../../modules/sold-environment"

  customer    = local.customer
  environment = var.environment
  env_id      = var.env_id
  profile     = "ephemeral"
  region      = var.region
  release = {
    version       = var.release_version
    image         = var.image
    worker_image  = var.worker_image
    migrate_image = var.migrate_image
  }
  owner      = var.owner
  expires_at = var.expires_at

  profile_settings = var.profile_settings
  tier_settings    = var.tier_settings

  registry     = var.registry
  cloudflare   = var.cloudflare
  access       = var.access
  email        = var.email
  alert_emails = var.alert_emails

  paused = var.paused
}
