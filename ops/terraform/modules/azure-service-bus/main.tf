terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
  }
}

# Optional queue backend for the JobQueue interface (ADR-0001: pg-boss is the default; this is the escape hatch).
# Excluded for ephemeral/dev profiles by default (composite `count`).

variable "name" {
  type = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku" {
  description = "Standard or Premium. Only Premium supports private endpoints and messaging units."
  type        = string
  default     = "Standard"
  validation {
    condition     = contains(["Standard", "Premium"], var.sku)
    error_message = "sku must be Standard or Premium (Basic has no topics and is not used)."
  }
}

variable "capacity" {
  description = "Premium messaging units (1, 2, 4, 8, 16). Must be 0 for Standard."
  type        = number
  default     = 0
}

variable "queues" {
  description = "Queue names. One per job class so autoscaling and DLQs are independent."
  type        = set(string)
  default     = ["orders", "emails", "webhooks", "search-index"]
}

variable "max_delivery_count" {
  type    = number
  default = 10
}

variable "private_endpoint" {
  description = "Premium only. Disables public access and creates a private endpoint."
  type = object({
    subnet_id           = string
    private_dns_zone_id = string
  })
  default = null
  validation {
    condition     = var.private_endpoint == null || var.sku == "Premium"
    error_message = "Private endpoints require the Premium SKU."
  }
}

variable "data_role_assignments" {
  description = "Entra data-plane roles keyed by label."
  type = map(object({
    principal_id         = string
    role_definition_name = string
  }))
  default = {}
  validation {
    condition = alltrue([
      for a in values(var.data_role_assignments) :
      contains(["Azure Service Bus Data Sender", "Azure Service Bus Data Receiver", "Azure Service Bus Data Owner"], a.role_definition_name)
    ])
    error_message = "role_definition_name must be one of the Azure Service Bus Data Sender / Receiver / Owner roles."
  }
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

resource "azurerm_servicebus_namespace" "this" {
  name                          = var.name
  location                      = var.location
  resource_group_name           = var.resource_group_name
  sku                           = var.sku
  capacity                      = var.sku == "Premium" ? var.capacity : 0
  local_auth_enabled            = false # Entra ID only; no shared access keys
  minimum_tls_version           = "1.2"
  public_network_access_enabled = var.private_endpoint == null
  tags                          = var.tags
}

resource "azurerm_servicebus_queue" "this" {
  for_each = var.queues

  name                                    = each.value
  namespace_id                            = azurerm_servicebus_namespace.this.id
  max_delivery_count                      = var.max_delivery_count
  dead_lettering_on_message_expiration    = true
  lock_duration                           = "PT1M"
  requires_duplicate_detection            = true
  duplicate_detection_history_time_window = "PT10M"
}

resource "azurerm_role_assignment" "this" {
  for_each = var.data_role_assignments

  scope                = azurerm_servicebus_namespace.this.id
  principal_id         = each.value.principal_id
  role_definition_name = each.value.role_definition_name
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
    private_connection_resource_id = azurerm_servicebus_namespace.this.id
    subresource_names              = ["namespace"]
    is_manual_connection           = false
  }

  private_dns_zone_group {
    name                 = "default"
    private_dns_zone_ids = [var.private_endpoint.private_dns_zone_id]
  }
}

output "id" {
  value = azurerm_servicebus_namespace.this.id
}

output "endpoint" {
  value = azurerm_servicebus_namespace.this.endpoint
}

output "namespace_name" {
  value = azurerm_servicebus_namespace.this.name
}

output "queue_names" {
  value = sort(keys(azurerm_servicebus_queue.this))
}
