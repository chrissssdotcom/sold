terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
  }
}

variable "name" {
  description = "Key Vault name (3-24 chars). Must include the env-id; the composite builds it with vault_name()."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,22}[a-z0-9]$", var.name))
    error_message = "Key Vault names are 3-24 chars, start with a letter, and use lowercase letters, digits and single hyphens."
  }
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "tenant_id" {
  type = string
}

variable "protect" {
  description = "Production posture: purge protection ON (irreversible), 90-day soft-delete retention, prevent_destroy. Non-prod: purge protection OFF, 7-day retention, and the provider purges on destroy so the name is released."
  type        = bool
  default     = false
}

variable "role_assignments" {
  description = "Data-plane RBAC assignments, keyed by a stable label."
  type = map(object({
    principal_id         = string
    role_definition_name = string # e.g. Key Vault Secrets User
  }))
  default = {}
}

variable "diagnostics_enabled" {
  description = "Send audit logs to Log Analytics. Static (not derived from the workspace id) so `count` is known at plan time."
  type        = bool
  default     = false
}

variable "log_analytics_workspace_id" {
  type    = string
  default = null
}

variable "tags" {
  type = map(string)
  validation {
    condition = alltrue([
      for t in ["sold:customer", "sold:environment", "sold:profile", "sold:owner", "sold:expires-at", "sold:release", "sold:env-id"] :
      contains(keys(var.tags), t) && try(length(var.tags[t]) > 0, false)
    ])
    error_message = "tags must include non-empty sold:customer, sold:environment, sold:profile, sold:owner, sold:expires-at, sold:release and sold:env-id."
  }
}

# prevent_destroy cannot be conditional: two resources, selected by count.
# Keep them identical apart from purge/retention values and `lifecycle`.
resource "azurerm_key_vault" "protected" {
  count = var.protect ? 1 : 0

  name                          = var.name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  tenant_id                     = var.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true
  soft_delete_retention_days    = 90
  public_network_access_enabled = true
  tags                          = var.tags

  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "azurerm_key_vault" "unprotected" {
  count = var.protect ? 0 : 1

  name                          = var.name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  tenant_id                     = var.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = false
  soft_delete_retention_days    = 7
  public_network_access_enabled = true
  tags                          = var.tags

  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }
}

locals {
  vault_id  = one(concat(azurerm_key_vault.protected[*].id, azurerm_key_vault.unprotected[*].id))
  vault_uri = one(concat(azurerm_key_vault.protected[*].vault_uri, azurerm_key_vault.unprotected[*].vault_uri))
}

resource "azurerm_role_assignment" "this" {
  for_each = var.role_assignments

  scope                = local.vault_id
  principal_id         = each.value.principal_id
  role_definition_name = each.value.role_definition_name
}

resource "azurerm_monitor_diagnostic_setting" "audit" {
  count = var.diagnostics_enabled ? 1 : 0

  name                       = "diag-keyvault"
  target_resource_id         = local.vault_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "AuditEvent"
  }
}

output "id" {
  value = local.vault_id
}

output "name" {
  value = var.name
}

output "vault_uri" {
  value = local.vault_uri
}

output "role_assignment_ids" {
  description = "Exposed so dependents (e.g. secret writes) can order after RBAC propagation."
  value       = [for r in azurerm_role_assignment.this : r.id]
}
