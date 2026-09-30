# Profile: ephemeral (PR preview / feature-branch environments).
# Data, not code. Loaded with -var-file by `sold env:up` and the env-up workflow.
# Cost posture: scale-to-zero web, smallest Burstable PostgreSQL, no Redis, no Service Bus,
# short-lived origin certificate, 30-day minimum log retention with a 0.5 GB/day ingestion cap.
# Capacity numbers are starting assumptions, to be revisited with measured data (docs/scaling.md).

profile_settings = {
  resource_lock          = false
  protect_stateful       = false
  redis_enabled          = false # Managed Redis cannot be stopped/paused: excluded by default
  service_bus_enabled    = false # pg-boss on Postgres is the default JobQueue
  private_endpoints      = false
  revision_mode          = "Single"
  postgres_password_auth = true # Entra token auth in the DB adapter is PENDING(phase-7)
  generate_app_secrets   = true
  log_retention_days     = 30
  log_daily_quota_gb     = 0.5
  budget_monthly         = 25
  origin_cert_days       = 30
}

tier_settings = {
  web_cpu             = 0.5
  web_memory          = "1Gi"
  web_min_replicas    = 0
  web_max_replicas    = 3
  web_concurrency     = 50
  worker_cpu          = 0.25
  worker_memory       = "0.5Gi"
  worker_min_replicas = 1
  worker_max_replicas = 1

  db_sku_name              = "B_Standard_B1ms"
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
