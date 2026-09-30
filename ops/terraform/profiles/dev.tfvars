# Profile: dev (shared integration environment, auto-deployed from main).
# Paused off-hours by the env-expire workflow (web/worker scale to zero, PostgreSQL stopped).

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
  log_daily_quota_gb     = 1
  budget_monthly         = 150
  origin_cert_days       = 365
}

tier_settings = {
  web_cpu             = 0.5
  web_memory          = "1Gi"
  web_min_replicas    = 1
  web_max_replicas    = 5
  web_concurrency     = 50
  worker_cpu          = 0.25
  worker_memory       = "0.5Gi"
  worker_min_replicas = 1
  worker_max_replicas = 2

  db_sku_name              = "B_Standard_B2s"
  db_storage_mb            = 32768
  db_ha_mode               = "Disabled"
  db_read_replica_count    = 0
  db_backup_retention_days = 7
  db_geo_redundant_backup  = false

  redis_sku_name      = "Balanced_B0"
  redis_ha            = false
  servicebus_sku      = "Standard"
  servicebus_capacity = 0
  zone_redundant      = false
}
