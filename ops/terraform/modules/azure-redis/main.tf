terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
  }
}

# Azure Managed Redis (azurerm_managed_redis). Azure Cache for Redis (Basic/Standard/Premium)
# retires on 2028-09-30 and Enterprise on 2027-03-30 - do not use azurerm_redis_cache. See ADR-0002.
# Managed Redis cannot be stopped, so ephemeral/dev profiles exclude it (composite `count`).

variable "name" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku_name" {
  description = "e.g. Balanced_B0 (0.5 GB), Balanced_B3, Balanced_B10, ComputeOptimized_X10, MemoryOptimized_M20. Names verified against the azurerm docs (ADR-0002)."
  type        = string
  validation {
    condition     = can(regex("^(Balanced_B|ComputeOptimized_X|MemoryOptimized_M|FlashOptimized_A)[0-9]+$", var.sku_name))
    error_message = "sku_name must be an Azure Managed Redis SKU such as Balanced_B5. Enterprise_* SKUs are not supported."
  }
}

variable "high_availability_enabled" {
  description = "Forces replacement when changed."
  type        = bool
  default     = true
}

variable "clustering_policy" {
  description = "OSSCluster needs a cluster-aware client; EnterpriseCluster presents one endpoint to any client. Changing forces database recreation."
  type        = string
  default     = "OSSCluster"
  validation {
    condition     = contains(["OSSCluster", "EnterpriseCluster", "NoCluster"], var.clustering_policy)
    error_message = "clustering_policy must be OSSCluster, EnterpriseCluster or NoCluster."
  }
}

variable "eviction_policy" {
  description = "The cache handler tolerates eviction; queues and correctness-critical state never live in Redis (AGENTS.md scale gate d)."
  type        = string
  default     = "VolatileLRU"
}

variable "access_keys_authentication_enabled" {
  description = "Access keys are ON until the cache handler supports Entra token auth (PENDING(phase-4)); the key is written to Key Vault by the composite and never printed. Set false to force Entra-only."
  type        = bool
  default     = true
}

variable "private_endpoint" {
  description = "When set, public access is disabled and a private endpoint is created."
  type = object({
    subnet_id           = string
    private_dns_zone_id = string
  })
  default = null
}

variable "data_owner_principal_ids" {
  description = "Entra object IDs granted the built-in default data access policy, keyed by label. Access keys stay disabled."
  type        = map(string)
  default     = {}
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

resource "azurerm_managed_redis" "this" {
  name                      = var.name
  resource_group_name       = var.resource_group_name
  location                  = var.location
  sku_name                  = var.sku_name
  high_availability_enabled = var.high_availability_enabled
  public_network_access     = var.private_endpoint == null ? "Enabled" : "Disabled"
  tags                      = var.tags

  default_database {
    access_keys_authentication_enabled = var.access_keys_authentication_enabled
    client_protocol                    = "Encrypted"
    clustering_policy                  = var.clustering_policy
    eviction_policy                    = var.eviction_policy
  }
}

resource "azurerm_managed_redis_access_policy_assignment" "this" {
  for_each = var.data_owner_principal_ids

  managed_redis_id = azurerm_managed_redis.this.id
  object_id        = each.value
}

resource "azurerm_private_endpoint" "this" {
  count = var.private_endpoint == null ? 0 : 1

  name                = "pe-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  subnet_id           = var.private_endpoint.subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "psc-${var.name}"
    private_connection_resource_id = azurerm_managed_redis.this.id
    subresource_names              = ["redisEnterprise"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [var.private_endpoint.private_dns_zone_id]
  }
}

output "id" {
  value = azurerm_managed_redis.this.id
}

output "hostname" {
  value = azurerm_managed_redis.this.hostname
}

output "port" {
  value = azurerm_managed_redis.this.default_database[0].port
}

output "primary_access_key" {
  description = "Null when access keys are disabled."
  value       = azurerm_managed_redis.this.default_database[0].primary_access_key
  sensitive   = true
}
