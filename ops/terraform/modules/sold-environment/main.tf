data "azurerm_client_config" "current" {}

locals {
  # Deterministic per-subscription suffix for globally unique Azure names.
  suffix = substr(sha1("${data.azurerm_client_config.current.subscription_id}/${var.env_id}"), 0, 6)

  # Mandatory tags on every Azure resource in this environment (checked by scripts/check-tags.ts).
  tags = {
    "sold:customer"    = var.customer
    "sold:environment" = var.environment
    "sold:profile"     = var.profile
    "sold:owner"       = var.owner
    "sold:expires-at"  = var.expires_at
    "sold:release"     = var.release.version
    "sold:env-id"      = var.env_id
  }

  tier = var.tier_settings
  ps   = var.profile_settings

  # Container Apps revision suffix from the instance build number, e.g. 1.4.0+demo.27 -> b27.
  revision_suffix = "b${regex("\\.([0-9]+)$", var.release.version)[0]}"

  # Key Vault names are max 24 chars: 'kv-' + up to 14 chars of the env-id + '-' + 6-char hash.
  key_vault_name = "kv-${substr(replace(var.env_id, "-", ""), 0, 14)}-${local.suffix}"

  postgres_name = "psql-${var.env_id}-${local.suffix}"
  redis_name    = "redis-${var.env_id}-${local.suffix}"
  bus_name      = "sb-${var.env_id}-${local.suffix}"

  use_edge     = var.cloudflare.enabled
  use_redis    = local.ps.redis_enabled
  use_bus      = local.ps.service_bus_enabled
  use_pe_redis = local.ps.private_endpoints && local.use_redis
  use_pe_bus   = local.ps.private_endpoints && local.use_bus && local.tier.servicebus_sku == "Premium"

  base_url = local.use_edge ? "https://${var.cloudflare.hostname}" : null
}

resource "azurerm_resource_group" "this" {
  name     = "rg-sold-${var.env_id}"
  location = var.region
  tags     = local.tags
}

# Guardrail 1 (Azure-native): a CanNotDelete lock on stateful environments. Removing it is a
# deliberate, reviewed change (promotion PR), never a side effect of `terraform destroy`.
resource "azurerm_management_lock" "resource_group" {
  count = local.ps.resource_lock ? 1 : 0

  name       = "lock-sold-${var.env_id}"
  scope      = azurerm_resource_group.this.id
  lock_level = "CanNotDelete"
  notes      = "sold:env-id=${var.env_id}. Remove only via an approved change."
}

resource "azurerm_role_assignment" "drift_reader" {
  count = var.drift_reader_object_id == null ? 0 : 1

  scope                = azurerm_resource_group.this.id
  role_definition_name = "Reader"
  principal_id         = var.drift_reader_object_id
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${var.env_id}"
  location            = var.region
  resource_group_name = azurerm_resource_group.this.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  count = var.registry.grant_pull ? 1 : 0

  scope                = var.registry.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

# ---------------------------------------------------------------------------
# Observability + budget
# ---------------------------------------------------------------------------
module "observability" {
  source = "../azure-observability"

  name                = var.env_id
  location            = var.region
  resource_group_name = azurerm_resource_group.this.name
  resource_group_id   = azurerm_resource_group.this.id
  log_retention_days  = local.ps.log_retention_days
  daily_quota_gb      = local.ps.log_daily_quota_gb
  alert_emails        = var.alert_emails
  budget = {
    amount     = local.ps.budget_monthly
    start_date = var.budget_start_date
  }
  alert_targets = {
    web_enabled      = true
    web_app_id       = module.container_apps.web_id
    postgres_enabled = true
    postgres_id      = module.postgres.server_id
  }
  tags = local.tags
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------
module "network" {
  source = "../azure-network"

  name                = var.env_id
  location            = var.region
  resource_group_name = azurerm_resource_group.this.name
  address_space       = var.address_space
  private_dns_zones = toset(concat(
    local.use_pe_redis ? ["redis"] : [],
    local.use_pe_bus ? ["servicebus"] : [],
  ))
  tags = local.tags
}

# ---------------------------------------------------------------------------
# Key Vault (name includes the env-id)
# ---------------------------------------------------------------------------
module "keyvault" {
  source = "../azure-keyvault"

  name                       = local.key_vault_name
  location                   = var.region
  resource_group_name        = azurerm_resource_group.this.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  protect                    = local.ps.protect_stateful
  diagnostics_enabled        = true
  log_analytics_workspace_id = module.observability.log_analytics_workspace_id
  role_assignments = merge(
    {
      app_reads_secrets = {
        principal_id         = azurerm_user_assigned_identity.app.principal_id
        role_definition_name = "Key Vault Secrets User"
      }
      deployer_writes_secrets = {
        principal_id         = data.azurerm_client_config.current.object_id
        role_definition_name = "Key Vault Secrets Officer"
      }
    },
    var.drift_reader_object_id == null ? {} : {
      drift_reads_secrets = {
        principal_id         = var.drift_reader_object_id
        role_definition_name = "Key Vault Secrets User"
      }
    },
  )
  tags = local.tags
}

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------
module "postgres" {
  source = "../azure-postgres"

  name                       = local.postgres_name
  location                   = var.region
  resource_group_name        = azurerm_resource_group.this.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = local.tier.db_sku_name
  storage_mb                 = local.tier.db_storage_mb
  ha_mode                    = local.tier.db_ha_mode
  read_replica_count         = local.tier.db_read_replica_count
  backup_retention_days      = local.tier.db_backup_retention_days
  geo_redundant_backup       = local.tier.db_geo_redundant_backup
  delegated_subnet_id        = module.network.postgres_subnet_id
  private_dns_zone_id        = module.network.postgres_private_dns_zone_id
  protect                    = local.ps.protect_stateful
  password_auth_enabled      = local.ps.postgres_password_auth
  diagnostics_enabled        = true
  log_analytics_workspace_id = module.observability.log_analytics_workspace_id
  entra_administrators = merge(
    {
      app = {
        object_id      = azurerm_user_assigned_identity.app.principal_id
        principal_name = azurerm_user_assigned_identity.app.name
        principal_type = "ServicePrincipal"
      }
    },
    var.entra_admin_group_object_id == null ? {} : {
      platform = {
        object_id      = var.entra_admin_group_object_id
        principal_name = "sold-platform-${var.customer}"
        principal_type = "Group"
      }
    },
  )
  tags = local.tags
}

# ---------------------------------------------------------------------------
# Redis (conditional: excluded for ephemeral/dev by default; Managed Redis cannot be stopped)
# ---------------------------------------------------------------------------
module "redis" {
  source = "../azure-redis"
  count  = local.use_redis ? 1 : 0

  name                      = local.redis_name
  location                  = var.region
  resource_group_name       = azurerm_resource_group.this.name
  sku_name                  = local.tier.redis_sku_name
  high_availability_enabled = local.tier.redis_ha
  private_endpoint = local.use_pe_redis ? {
    subnet_id           = module.network.private_endpoint_subnet_id
    private_dns_zone_id = module.network.private_dns_zone_ids["redis"]
  } : null
  data_owner_principal_ids = { app = azurerm_user_assigned_identity.app.principal_id }
  tags                     = local.tags
}

# ---------------------------------------------------------------------------
# Service Bus (conditional: optional JobQueue backend; pg-boss is the default)
# ---------------------------------------------------------------------------
module "service_bus" {
  source = "../azure-service-bus"
  count  = local.use_bus ? 1 : 0

  name                = local.bus_name
  location            = var.region
  resource_group_name = azurerm_resource_group.this.name
  sku                 = local.tier.servicebus_sku
  capacity            = local.tier.servicebus_capacity
  private_endpoint = local.use_pe_bus ? {
    subnet_id           = module.network.private_endpoint_subnet_id
    private_dns_zone_id = module.network.private_dns_zone_ids["servicebus"]
  } : null
  data_role_assignments = {
    app_owner = {
      principal_id         = azurerm_user_assigned_identity.app.principal_id
      role_definition_name = "Azure Service Bus Data Owner"
    }
  }
  tags = local.tags
}

# ---------------------------------------------------------------------------
# Cloudflare IP ranges (origin lock-down) - only when the edge is used
# ---------------------------------------------------------------------------
data "cloudflare_ip_ranges" "this" {
  count = local.use_edge ? 1 : 0
}

# ---------------------------------------------------------------------------
# Container Apps
# ---------------------------------------------------------------------------
module "container_apps" {
  source = "../azure-container-apps"

  name                               = var.env_id
  location                           = var.region
  resource_group_name                = azurerm_resource_group.this.name
  infrastructure_subnet_id           = module.network.aca_subnet_id
  infrastructure_resource_group_name = "rg-sold-${var.env_id}-aca"
  log_analytics_workspace_id         = module.observability.log_analytics_workspace_id
  identity_id                        = azurerm_user_assigned_identity.app.id
  identity_client_id                 = azurerm_user_assigned_identity.app.client_id
  registry_server                    = var.registry.login_server
  image                              = var.release.image
  worker_image                       = var.release.worker_image
  migrate_image                      = var.release.migrate_image
  revision_mode                      = local.ps.revision_mode
  revision_suffix                    = local.ps.revision_mode == "Multiple" ? local.revision_suffix : null
  previous_revision_suffix           = var.previous_revision_suffix
  canary_percent                     = var.canary_percent
  paused                             = var.paused
  zone_redundancy_enabled            = local.tier.zone_redundant
  workload_profile                   = local.tier.dedicated_profile
  ingress_allowed_cidrs              = local.use_edge ? data.cloudflare_ip_ranges.this[0].ipv4_cidrs : []
  custom_domain_enabled              = local.use_edge
  custom_domain_hostname             = local.use_edge ? module.cloudflare_edge[0].asuid_hostname : null

  custom_domain_certificate_secret_id = local.use_edge ? azurerm_key_vault_secret.app["origin-certificate"].versionless_id : null

  web = {
    cpu          = local.tier.web_cpu
    memory       = local.tier.web_memory
    min_replicas = local.tier.web_min_replicas
    max_replicas = local.tier.web_max_replicas
    concurrency  = local.tier.web_concurrency
    port         = 3000
  }
  worker = {
    cpu          = local.tier.worker_cpu
    memory       = local.tier.worker_memory
    min_replicas = local.tier.worker_min_replicas
    max_replicas = local.tier.worker_max_replicas
  }

  servicebus_worker_scaling = local.use_bus ? {
    namespace_fqdn = replace(replace(module.service_bus[0].endpoint, "https://", ""), ":443/", "")
    queue_name     = "orders"
    message_count  = 50
  } : null

  app_env = merge(
    {
      NODE_ENV            = "production"
      SOLD_ENVIRONMENT    = var.profile
      SOLD_VERSION        = var.release.version
      SOLD_SCALE_MODE     = var.scale_mode
      SOLD_ENV_ID         = var.env_id
      SOLD_CUSTOMER       = var.customer
      DATABASE_POOLER     = module.postgres.pgbouncer_enabled ? "pgbouncer" : "none"
      AZURE_KEY_VAULT_URI = module.keyvault.vault_uri
      DATABASE_NAME       = module.postgres.database_name
    },
    local.use_edge ? {
      SOLD_BASE_URL             = local.base_url
      SOLD_STORAGE_BUCKET       = module.cloudflare_r2[0].bucket_name
      SOLD_STORAGE_ENDPOINT     = module.cloudflare_r2[0].s3_endpoint
      NEXT_PUBLIC_TURNSTILE_KEY = coalesce(module.cloudflare_edge[0].turnstile_site_key, "")
    } : {},
    var.extra_app_env,
  )

  secret_env = {
    for name, def in local.secret_defs :
    def.env => (def.create ? azurerm_key_vault_secret.app[name].versionless_id : "${trimsuffix(module.keyvault.vault_uri, "/")}/secrets/${name}")
    if def.needed && def.env != null
  }

  tags = local.tags

  depends_on = [module.keyvault]
}

# ---------------------------------------------------------------------------
# Cloudflare edge (per environment)
# ---------------------------------------------------------------------------
module "cloudflare_edge" {
  source = "../cloudflare-edge"
  count  = local.use_edge ? 1 : 0

  account_id                       = var.cloudflare.account_id
  zone_id                          = var.cloudflare.zone_id
  env_id                           = var.env_id
  hostname                         = var.cloudflare.hostname
  origin_fqdn                      = module.container_apps.web_fqdn
  custom_domain_verification_id    = module.container_apps.custom_domain_verification_id
  origin_certificate_validity_days = local.ps.origin_cert_days
}

module "cloudflare_r2" {
  source = "../cloudflare-r2"
  count  = local.use_edge ? 1 : 0

  account_id = var.cloudflare.account_id
  name       = "sold-${var.env_id}"
  protect    = local.ps.protect_stateful
}

module "cloudflare_access" {
  source = "../cloudflare-access"
  count  = local.use_edge && var.access.enabled ? 1 : 0

  account_id            = var.cloudflare.account_id
  zone_id               = var.cloudflare.zone_id
  env_id                = var.env_id
  hostname              = var.cloudflare.hostname
  allowed_email_domains = var.access.allowed_email_domains
  allowed_emails        = var.access.allowed_emails
}

module "cloudflare_email_dns" {
  source = "../cloudflare-email-dns"
  count  = local.use_edge && var.email.enabled ? 1 : 0

  zone_id                  = var.cloudflare.zone_id
  env_id                   = var.env_id
  sending_domain           = var.email.sending_domain
  spf_includes             = var.email.spf_includes
  dkim_records             = var.email.dkim_records
  dmarc                    = { policy = var.email.dmarc_policy, report_address = var.email.dmarc_report_address }
  cloudflare_email_sending = var.email.cloudflare_email_sending
}
