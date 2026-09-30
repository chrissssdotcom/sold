# Customer bootstrap: applied ONCE per customer, by a human with rights on the customer's
# subscriptions (or the platform team via Azure Lighthouse), from a laptop with `az login`.
# It creates what every environment needs but no environment owns:
#   * the customer's OWN Terraform state storage (Entra-only, versioned, delete-locked)
#   * the container registry that holds the signed, build-once images
#   * two GitHub OIDC identities (federated credentials, no secrets): non-prod and PROD
#   * the Cloudflare zone baseline (TLS settings, cache/rate-limit/noindex rulesets)
# State for this root is local by design (chicken-and-egg); commit nothing from it. See
# docs/runbooks/environments.md ("Customer bootstrap").

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
  }
}

provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  # v5 registers nothing by default: register exactly what Sold's environments use.
  resource_providers_to_register = [
    "Microsoft.App",
    "Microsoft.Cache",
    "Microsoft.Consumption",
    "Microsoft.ContainerRegistry",
    "Microsoft.DBforPostgreSQL",
    "Microsoft.Insights",
    "Microsoft.KeyVault",
    "Microsoft.ManagedIdentity",
    "Microsoft.Network",
    "Microsoft.OperationalInsights",
    "Microsoft.ServiceBus",
    "Microsoft.Storage",
  ]

  features {}
}

provider "cloudflare" {}

variable "subscription_id" {
  description = "Subscription that hosts shared resources and non-production environments."
  type        = string
}

variable "customer" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.customer))
    error_message = "customer must be 3-12 lowercase alphanumerics starting with a letter."
  }
}

variable "region" {
  type = string
}

variable "owner" {
  type = string
}

variable "state_storage_account_name" {
  description = "Globally unique, 3-24 lowercase alphanumerics, e.g. stsolddemotfstate."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.state_storage_account_name))
    error_message = "Storage account names are 3-24 lowercase letters and digits."
  }
}

variable "registry_name" {
  description = "Globally unique, 5-50 alphanumerics, e.g. acrsolddemo."
  type        = string
  validation {
    condition     = can(regex("^[a-zA-Z0-9]{5,50}$", var.registry_name))
    error_message = "Registry names are 5-50 alphanumerics."
  }
}

variable "github_repository" {
  description = "owner/name of the customer instance repository that runs the pipelines."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like owner/name."
  }
}

variable "nonprod_scope" {
  description = "Scope the non-production identity may deploy to (subscription id path, e.g. /subscriptions/<id>)."
  type        = string
}

variable "prod_scope" {
  description = "Scope the PRODUCTION identity may deploy to. Prefer a separate subscription."
  type        = string
}

variable "cloudflare" {
  type = object({
    enabled              = bool
    account_id           = optional(string)
    zone_name            = optional(string)
    create_zone          = optional(bool, false)
    production_hostnames = optional(list(string), [])
  })
  default = { enabled = false }
}

locals {
  tags = {
    "sold:customer"    = var.customer
    "sold:environment" = "shared"
    "sold:profile"     = "shared"
    "sold:owner"       = var.owner
    "sold:expires-at"  = "never"
    "sold:release"     = "bootstrap"
    "sold:env-id"      = "${var.customer}-shared"
  }
}

data "azurerm_client_config" "current" {}

resource "azurerm_resource_group" "shared" {
  name     = "rg-sold-${var.customer}-shared"
  location = var.region
  tags     = local.tags
}

resource "azurerm_management_lock" "shared" {
  name       = "lock-sold-${var.customer}-shared"
  scope      = azurerm_resource_group.shared.id
  lock_level = "CanNotDelete"
  notes      = "Holds Terraform state and the container registry."
}

# --- Terraform state: the customer's own storage account, Entra ID only -----------------------
resource "azurerm_storage_account" "state" {
  name                            = var.state_storage_account_name
  resource_group_name             = azurerm_resource_group.shared.name
  location                        = var.region
  account_tier                    = "Standard"
  account_replication_type        = "GRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false # no account keys, no SAS: Microsoft Entra ID only
  default_to_oauth_authentication = true
  allow_nested_items_to_be_public = false
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }
}

resource "azurerm_storage_container" "nonprod" {
  name                  = "tfstate"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "prod" {
  name                  = "tfstate-prod"
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"
}

# --- Registry: build once, promote the same digest -----------------------------------------------
resource "azurerm_container_registry" "this" {
  name                          = var.registry_name
  resource_group_name           = azurerm_resource_group.shared.name
  location                      = var.region
  sku                           = "Standard"
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = true
  tags                          = local.tags
}

# --- GitHub OIDC identities (workload identity federation; no client secrets anywhere) ----------
resource "azurerm_user_assigned_identity" "github_nonprod" {
  name                = "id-gh-${var.customer}-nonprod"
  location            = var.region
  resource_group_name = azurerm_resource_group.shared.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "github_prod" {
  name                = "id-gh-${var.customer}-prod"
  location            = var.region
  resource_group_name = azurerm_resource_group.shared.name
  tags                = local.tags
}

# Read-only identity for the nightly production drift plan (no environment approval needed, cannot change anything).
resource "azurerm_user_assigned_identity" "github_prod_readonly" {
  name                = "id-gh-${var.customer}-prod-ro"
  location            = var.region
  resource_group_name = azurerm_resource_group.shared.name
  tags                = local.tags
}

locals {
  github_issuer   = "https://token.actions.githubusercontent.com"
  github_audience = ["api://AzureADTokenExchange"]

  # Subjects are matched case-sensitively and never include numeric repo/owner IDs.
  nonprod_subjects = {
    main         = "repo:${var.github_repository}:ref:refs/heads/main"
    pull_request = "repo:${var.github_repository}:pull_request"
    dev          = "repo:${var.github_repository}:environment:dev"
    stage        = "repo:${var.github_repository}:environment:stage"
    ephemeral    = "repo:${var.github_repository}:environment:ephemeral"
  }
}

resource "azurerm_federated_identity_credential" "nonprod" {
  for_each = local.nonprod_subjects

  name                      = "gh-${each.key}"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_nonprod.id
  issuer                    = local.github_issuer
  audience                  = local.github_audience
  subject                   = each.value
}

# Production: ONLY jobs bound to the GitHub `prod` environment (required reviewers + deploy freeze).
resource "azurerm_federated_identity_credential" "prod" {
  name                      = "gh-prod"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_prod.id
  issuer                    = local.github_issuer
  audience                  = local.github_audience
  subject                   = "repo:${var.github_repository}:environment:prod"
}

resource "azurerm_federated_identity_credential" "prod_readonly" {
  name                      = "gh-prod-readonly"
  user_assigned_identity_id = azurerm_user_assigned_identity.github_prod_readonly.id
  issuer                    = local.github_issuer
  audience                  = local.github_audience
  subject                   = "repo:${var.github_repository}:environment:prod-readonly"
}

# Deploy identities create resource groups and assign roles to environment identities.
resource "azurerm_role_assignment" "nonprod_contributor" {
  scope                = var.nonprod_scope
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.github_nonprod.principal_id
}

resource "azurerm_role_assignment" "nonprod_rbac_admin" {
  scope                = var.nonprod_scope
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.github_nonprod.principal_id
}

resource "azurerm_role_assignment" "prod_contributor" {
  scope                = var.prod_scope
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.github_prod.principal_id
}

resource "azurerm_role_assignment" "prod_rbac_admin" {
  scope                = var.prod_scope
  role_definition_name = "Role Based Access Control Administrator"
  principal_id         = azurerm_user_assigned_identity.github_prod.principal_id
}

resource "azurerm_role_assignment" "nonprod_state" {
  scope                = azurerm_storage_container.nonprod.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github_nonprod.principal_id
}

resource "azurerm_role_assignment" "prod_state" {
  scope                = azurerm_storage_container.prod.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.github_prod.principal_id
}

resource "azurerm_role_assignment" "prod_readonly_reader" {
  scope                = var.prod_scope
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.github_prod_readonly.principal_id
}

resource "azurerm_role_assignment" "prod_readonly_state" {
  scope                = azurerm_storage_container.prod.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.github_prod_readonly.principal_id
}

# The bootstrap operator can read/write state while bootstrapping.
resource "azurerm_role_assignment" "operator_state" {
  scope                = azurerm_storage_account.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}

# CI builds push to the registry; only the prod identity may pull for promotion checks.
resource "azurerm_role_assignment" "nonprod_acr_push" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.github_nonprod.principal_id
}

resource "azurerm_role_assignment" "prod_acr_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.github_prod.principal_id
}

module "cloudflare_zone" {
  source = "../../modules/cloudflare-zone"
  count  = var.cloudflare.enabled ? 1 : 0

  account_id           = var.cloudflare.account_id
  zone_name            = var.cloudflare.zone_name
  create_zone          = var.cloudflare.create_zone
  production_hostnames = var.cloudflare.production_hostnames
}

output "state_backend" {
  description = "Values for the environment roots' backend blocks."
  value = {
    storage_account_name = azurerm_storage_account.state.name
    container_nonprod    = azurerm_storage_container.nonprod.name
    container_prod       = azurerm_storage_container.prod.name
  }
}

output "registry" {
  value = {
    id           = azurerm_container_registry.this.id
    login_server = azurerm_container_registry.this.login_server
  }
}

output "github_oidc" {
  description = "Client IDs for the GitHub variables AZURE_CLIENT_ID_NONPROD, AZURE_CLIENT_ID_PROD and AZURE_CLIENT_ID_PROD_RO (identifiers, not secrets)."
  value = {
    tenant_id         = data.azurerm_client_config.current.tenant_id
    subscription_id   = var.subscription_id
    client_id_nonprod = azurerm_user_assigned_identity.github_nonprod.client_id
    client_id_prod    = azurerm_user_assigned_identity.github_prod.client_id
    client_id_prod_ro = azurerm_user_assigned_identity.github_prod_readonly.client_id
  }
}
