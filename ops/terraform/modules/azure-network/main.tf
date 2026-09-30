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
  description = "Name prefix (the env-id)."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "address_space" {
  description = "Per-environment /16. Environments are isolated (no peering), so ranges may repeat across environments."
  type        = string
  default     = "10.42.0.0/16"
}

variable "private_dns_zones" {
  description = "Extra private DNS zones to create and link, keyed by purpose (redis, servicebus). Only create what the profile uses."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for z in var.private_dns_zones : contains(["redis", "servicebus"], z)])
    error_message = "private_dns_zones may only contain: redis, servicebus."
  }
}

variable "tags" {
  description = "Mandatory sold:* tags plus any extras."
  type        = map(string)
  validation {
    condition = alltrue([
      for t in ["sold:customer", "sold:environment", "sold:profile", "sold:owner", "sold:expires-at", "sold:release", "sold:env-id"] :
      contains(keys(var.tags), t) && try(length(var.tags[t]) > 0, false)
    ])
    error_message = "tags must include non-empty sold:customer, sold:environment, sold:profile, sold:owner, sold:expires-at, sold:release and sold:env-id."
  }
}

locals {
  # /24 slices of the /16.
  aca_prefix      = cidrsubnet(var.address_space, 8, 0)
  postgres_prefix = cidrsubnet(var.address_space, 8, 1)
  pe_prefix       = cidrsubnet(var.address_space, 8, 2)

  extra_zone_names = {
    # Names of the privatelink zones. The Managed Redis zone name is UNVERIFIED (see ADR-0002).
    redis      = "privatelink.redis.azure.net"
    servicebus = "privatelink.servicebus.windows.net"
  }
}

resource "azurerm_virtual_network" "this" {
  name                = "vnet-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  address_space       = [var.address_space]
  tags                = var.tags
}

# Container Apps environment (workload profiles). Delegation to Microsoft.App/environments.
resource "azurerm_subnet" "aca" {
  name                 = "snet-aca"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.aca_prefix]

  delegation {
    name = "aca"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

# PostgreSQL Flexible Server (private access). Delegated subnet.
resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [local.postgres_prefix]

  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "private_endpoints" {
  name                              = "snet-pe"
  resource_group_name               = var.resource_group_name
  virtual_network_name              = azurerm_virtual_network.this.name
  address_prefixes                  = [local.pe_prefix]
  private_endpoint_network_policies = "Enabled"
}

# Only the Container Apps subnet may reach PostgreSQL (5432 direct, 6432 PgBouncer).
resource "azurerm_network_security_group" "postgres" {
  name                = "nsg-${var.name}-postgres"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags

  security_rule {
    name                       = "allow-aca-postgres"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["5432", "6432"]
    source_address_prefix      = local.aca_prefix
    destination_address_prefix = local.postgres_prefix
  }

  security_rule {
    name                       = "deny-other-vnet-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "VirtualNetwork"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "postgres" {
  subnet_id                 = azurerm_subnet.postgres.id
  network_security_group_id = azurerm_network_security_group.postgres.id
}

resource "azurerm_private_dns_zone" "postgres" {
  # Must end with .postgres.database.azure.com for VNet-integrated flexible servers.
  name                = "${var.name}.private.postgres.database.azure.com"
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                = "link-postgres"
  private_dns_zone_id = azurerm_private_dns_zone.postgres.id
  virtual_network_id  = azurerm_virtual_network.this.id
  tags                = var.tags
}

resource "azurerm_private_dns_zone" "extra" {
  for_each            = var.private_dns_zones
  name                = local.extra_zone_names[each.key]
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "extra" {
  for_each            = var.private_dns_zones
  name                = "link-${each.key}"
  private_dns_zone_id = azurerm_private_dns_zone.extra[each.key].id
  virtual_network_id  = azurerm_virtual_network.this.id
  tags                = var.tags
}

output "vnet_id" {
  value = azurerm_virtual_network.this.id
}

output "aca_subnet_id" {
  value = azurerm_subnet.aca.id
}

output "postgres_subnet_id" {
  value = azurerm_subnet.postgres.id
}

output "private_endpoint_subnet_id" {
  value = azurerm_subnet.private_endpoints.id
}

output "postgres_private_dns_zone_id" {
  description = "Depends on the VNet link so a server created with this zone never races the link."
  value       = azurerm_private_dns_zone.postgres.id
  depends_on  = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

output "private_dns_zone_ids" {
  description = "Extra zones keyed by purpose."
  value       = { for k, z in azurerm_private_dns_zone.extra : k => z.id }
}
