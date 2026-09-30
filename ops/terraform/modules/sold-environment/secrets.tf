# Application secrets live in Key Vault and reach the containers as Key Vault references
# (resolved by the platform with the environment identity). Values are never passed as plain
# environment variables. Terraform state (Azure Storage, Entra-only, per environment) holds the
# generated values; treat the state container as secret material.

resource "random_password" "metrics_token" {
  length  = 48
  special = false
}

# SOLD_SECRET_KEY is the root of envelope encryption for stored credentials. It is generated here
# ONLY for non-production profiles. Production keys are provisioned out of band (customer KMS process)
# because regenerating this value would make stored credentials undecryptable.
resource "random_id" "secret_key" {
  count       = local.ps.generate_app_secrets ? 1 : 0
  byte_length = 32
}

locals {
  # create: Terraform writes the secret. needed: the containers reference it (create = false means
  # it must already exist in the vault, e.g. production SOLD_SECRET_KEY).
  secret_defs = {
    "database-url"                  = { create = true, needed = true, env = "DATABASE_URL", content_type = "text/plain" }
    "database-migration-url"        = { create = true, needed = true, env = "DATABASE_MIGRATION_URL", content_type = "text/plain" }
    "database-replica-url"          = { create = local.tier.db_read_replica_count > 0, needed = local.tier.db_read_replica_count > 0, env = "DATABASE_REPLICA_URL", content_type = "text/plain" }
    "redis-url"                     = { create = local.use_redis, needed = local.use_redis, env = "REDIS_URL", content_type = "text/plain" }
    "metrics-token"                 = { create = true, needed = true, env = "METRICS_TOKEN", content_type = "text/plain" }
    "sold-secret-key"               = { create = local.ps.generate_app_secrets, needed = true, env = "SOLD_SECRET_KEY", content_type = "text/plain" }
    "appinsights-connection-string" = { create = true, needed = true, env = "APPLICATIONINSIGHTS_CONNECTION_STRING", content_type = "text/plain" }
    "turnstile-secret"              = { create = local.use_edge, needed = local.use_edge, env = "TURNSTILE_SECRET_KEY", content_type = "text/plain" }
    "origin-certificate"            = { create = local.use_edge, needed = false, env = null, content_type = "application/x-pem-file" }
    "db-admin-password"             = { create = local.ps.postgres_password_auth, needed = false, env = null, content_type = "text/plain" }
  }

  db_login    = coalesce(module.postgres.administrator_login, azurerm_user_assigned_identity.app.name)
  db_password = try(module.postgres.administrator_password, "")
  db_userinfo = local.ps.postgres_password_auth ? "${local.db_login}:${local.db_password}" : local.db_login
  db_path     = "${module.postgres.fqdn}:%s/${module.postgres.database_name}?sslmode=require"

  redis_key      = try(module.redis[0].primary_access_key, null)
  redis_userinfo = local.redis_key == null ? "" : ":${local.redis_key}@"

  secret_values = {
    "database-url"                  = "postgres://${local.db_userinfo}@${format(local.db_path, tostring(module.postgres.port))}"
    "database-migration-url"        = "postgres://${local.db_userinfo}@${format(local.db_path, "5432")}"
    "database-replica-url"          = length(module.postgres.replica_fqdns) > 0 ? "postgres://${local.db_userinfo}@${module.postgres.replica_fqdns[0]}:5432/${module.postgres.database_name}?sslmode=require" : ""
    "redis-url"                     = local.use_redis ? "rediss://${local.redis_userinfo}${module.redis[0].hostname}:${module.redis[0].port}" : ""
    "metrics-token"                 = random_password.metrics_token.result
    "sold-secret-key"               = local.ps.generate_app_secrets ? random_id.secret_key[0].b64_std : ""
    "appinsights-connection-string" = module.observability.application_insights_connection_string
    "turnstile-secret"              = local.use_edge ? coalesce(module.cloudflare_edge[0].turnstile_secret, "unset") : ""
    "origin-certificate"            = local.use_edge ? module.cloudflare_edge[0].origin_certificate_bundle_pem : ""
    "db-admin-password"             = local.db_password
  }
}

resource "azurerm_key_vault_secret" "app" {
  for_each = { for name, def in local.secret_defs : name => def if def.create }

  name         = each.key
  key_vault_id = module.keyvault.id
  value        = local.secret_values[each.key]
  content_type = each.value.content_type
  tags         = local.tags

  depends_on = [module.keyvault]
}
