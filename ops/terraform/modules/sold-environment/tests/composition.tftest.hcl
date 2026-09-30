# Offline tests for the composite: no cloud credentials needed (mock providers).
#   cd ops/terraform/modules/sold-environment && terraform test     (or: tofu test)

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "11111111-1111-1111-1111-111111111111"
      subscription_id = "22222222-2222-2222-2222-222222222222"
      object_id       = "33333333-3333-3333-3333-333333333333"
      client_id       = "44444444-4444-4444-4444-444444444444"
    }
  }

  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.OperationalInsights/workspaces/log-mock"
    }
  }

  mock_resource "azurerm_application_insights" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.Insights/components/appi-mock"
    }
  }

  mock_resource "azurerm_monitor_action_group" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.Insights/actionGroups/ag-mock"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id        = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.KeyVault/vaults/kv-mock"
      vault_uri = "https://kv-mock.vault.azure.net/"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-mock"
    }
  }

  mock_resource "azurerm_managed_redis" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.Cache/redisEnterprise/redis-mock"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.Network/virtualNetworks/vnet-mock"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.Network/virtualNetworks/vnet-mock/subnets/snet-mock"
    }
  }

  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.Network/privateDnsZones/mock.private.postgres.database.azure.com"
    }
  }

  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.App/managedEnvironments/cae-mock"
    }
  }

  mock_resource "azurerm_network_security_group" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.Network/networkSecurityGroups/nsg-mock"
    }
  }

  mock_resource "azurerm_servicebus_namespace" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.ServiceBus/namespaces/sb-mock"
    }
  }

  mock_resource "azurerm_container_app" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.App/containerApps/web"
    }
  }

  mock_resource "azurerm_key_vault_secret" {
    defaults = {
      id             = "https://kv-mock.vault.azure.net/secrets/mock/0123456789abcdef0123456789abcdef"
      versionless_id = "https://kv-mock.vault.azure.net/secrets/mock"
      version        = "0123456789abcdef0123456789abcdef"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-mock"
      principal_id = "55555555-5555-5555-5555-555555555555"
      client_id    = "66666666-6666-6666-6666-666666666666"
      tenant_id    = "11111111-1111-1111-1111-111111111111"
    }
  }
}
mock_provider "cloudflare" {}
mock_provider "random" {}
mock_provider "tls" {}

variables {
  customer    = "demo"
  environment = "eph-my-branch-1a2b"
  env_id      = "demo-eph-my-branch-1a2b"
  profile     = "ephemeral"
  region      = "australiaeast"
  release = {
    version = "1.4.0+demo.27"
    image   = "acrsolddemo.azurecr.io/sold/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  owner        = "chris"
  expires_at   = "2026-10-02T12:00:00Z"
  alert_emails = ["platform@demo.example"]
  registry = {
    id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acr"
    login_server = "acrsolddemo.azurecr.io"
  }
  profile_settings = {
    resource_lock          = false
    protect_stateful       = false
    redis_enabled          = false
    service_bus_enabled    = false
    private_endpoints      = false
    revision_mode          = "Single"
    postgres_password_auth = true
    generate_app_secrets   = true
    log_retention_days     = 30
    log_daily_quota_gb     = 0.5
    budget_monthly         = 25
    origin_cert_days       = 30
  }
  tier_settings = {
    web_cpu                  = 0.5
    web_memory               = "1Gi"
    web_min_replicas         = 0
    web_max_replicas         = 3
    web_concurrency          = 50
    worker_cpu               = 0.25
    worker_memory            = "0.5Gi"
    worker_min_replicas      = 1
    worker_max_replicas      = 1
    db_sku_name              = "B_Standard_B1ms"
    db_storage_mb            = 32768
    db_ha_mode               = "Disabled"
    db_read_replica_count    = 0
    db_backup_retention_days = 7
    db_geo_redundant_backup  = false
    redis_sku_name           = "Balanced_B0"
    redis_ha                 = false
    servicebus_sku           = "Standard"
    servicebus_capacity      = 0
    zone_redundant           = false
  }
}

run "ephemeral_has_own_resource_group_and_no_redis_or_service_bus" {
  command = plan

  assert {
    condition     = azurerm_resource_group.this.name == "rg-sold-demo-eph-my-branch-1a2b"
    error_message = "each ephemeral environment must own a resource group named after its env-id"
  }
  assert {
    condition     = length(module.redis) == 0 && length(module.service_bus) == 0
    error_message = "Redis and Service Bus must be excluded for the ephemeral profile by default"
  }
  assert {
    condition     = length(azurerm_management_lock.resource_group) == 0
    error_message = "ephemeral environments must not carry a delete lock"
  }
}

run "mandatory_tags_are_complete" {
  command = plan

  assert {
    condition = alltrue([
      for k in ["sold:customer", "sold:environment", "sold:profile", "sold:owner", "sold:expires-at", "sold:release", "sold:env-id"] :
      contains(keys(azurerm_resource_group.this.tags), k)
    ])
    error_message = "resource group is missing a mandatory sold:* tag"
  }
  assert {
    condition     = azurerm_resource_group.this.tags["sold:env-id"] == "demo-eph-my-branch-1a2b" && azurerm_resource_group.this.tags["sold:release"] == "1.4.0+demo.27"
    error_message = "sold:env-id / sold:release tag values are wrong"
  }
}

run "key_vault_name_contains_env_id_and_fits_24_chars" {
  command = plan

  assert {
    condition     = length(module.keyvault.name) <= 24 && startswith(module.keyvault.name, "kv-demoephmybranc")
    error_message = "Key Vault name must embed (a prefix of) the env-id and be at most 24 characters"
  }
}

run "postgres_burstable_has_no_pgbouncer" {
  command = plan

  assert {
    condition     = module.postgres.pgbouncer_enabled == false
    error_message = "built-in PgBouncer is not available on Burstable SKUs"
  }
}

run "prod_requires_protection" {
  command = plan

  variables {
    environment = "prod"
    env_id      = "demo-prod"
    profile     = "prod"
    expires_at  = "never"
  }

  expect_failures = [var.profile_settings]
}

run "prod_cannot_expire" {
  command = plan

  variables {
    environment = "prod"
    env_id      = "demo-prod"
    profile     = "prod"
    expires_at  = "2026-10-02T12:00:00Z"
    profile_settings = {
      resource_lock          = true
      protect_stateful       = true
      redis_enabled          = false
      service_bus_enabled    = false
      private_endpoints      = false
      revision_mode          = "Multiple"
      postgres_password_auth = true
      generate_app_secrets   = false
      log_retention_days     = 90
      log_daily_quota_gb     = -1
      budget_monthly         = 3000
      origin_cert_days       = 365
    }
  }

  expect_failures = [var.expires_at]
}

run "ephemeral_cannot_live_forever" {
  command = plan

  variables {
    expires_at = "never"
  }

  expect_failures = [var.expires_at]
}

run "env_id_must_start_with_customer" {
  command = plan

  variables {
    env_id = "other-eph-my-branch-1a2b"
  }

  expect_failures = [var.env_id]
}

run "release_image_must_be_digest_pinned" {
  command = plan

  variables {
    release = {
      version = "1.4.0+demo.27"
      image   = "acrsolddemo.azurecr.io/sold/app:latest"
    }
  }

  expect_failures = [var.release]
}

run "protected_prod_plan_uses_protected_variants_and_lock" {
  command = plan

  variables {
    environment = "prod"
    env_id      = "demo-prod"
    profile     = "prod"
    expires_at  = "never"
    profile_settings = {
      resource_lock          = true
      protect_stateful       = true
      redis_enabled          = true
      service_bus_enabled    = false
      private_endpoints      = true
      revision_mode          = "Multiple"
      postgres_password_auth = true
      generate_app_secrets   = false
      log_retention_days     = 90
      log_daily_quota_gb     = -1
      budget_monthly         = 3000
      origin_cert_days       = 365
    }
    tier_settings = {
      web_cpu                  = 1
      web_memory               = "2Gi"
      web_min_replicas         = 2
      web_max_replicas         = 20
      web_concurrency          = 100
      worker_cpu               = 0.5
      worker_memory            = "1Gi"
      worker_min_replicas      = 1
      worker_max_replicas      = 5
      db_sku_name              = "GP_Standard_D2ds_v5"
      db_storage_mb            = 131072
      db_ha_mode               = "ZoneRedundant"
      db_read_replica_count    = 0
      db_backup_retention_days = 14
      db_geo_redundant_backup  = false
      redis_sku_name           = "Balanced_B3"
      redis_ha                 = true
      servicebus_sku           = "Standard"
      servicebus_capacity      = 0
      zone_redundant           = true
    }
  }

  assert {
    condition     = length(azurerm_management_lock.resource_group) == 1
    error_message = "prod must carry a CanNotDelete lock"
  }
  assert {
    condition     = length(module.redis) == 1
    error_message = "prod must include Managed Redis"
  }
  assert {
    condition     = module.postgres.pgbouncer_enabled == true
    error_message = "General Purpose SKUs must enable built-in PgBouncer"
  }
}
