# Tier: standard. Used by stage/prod. Replica ranges follow the tier table in docs/scaling.md; SKUs and
# per-replica sizes are starting assumptions until the capacity model there is validated by k6 runs (Phase 8). PostgreSQL SKU names and regional availability
# must be checked with `az postgres flexible-server list-skus` before apply (ADR-0002).

tier_settings = {
  web_cpu             = 1
  web_memory          = "2Gi"
  web_min_replicas    = 2
  web_max_replicas    = 6
  web_concurrency     = 100
  worker_cpu          = 0.5
  worker_memory       = "1Gi"
  worker_min_replicas = 1
  worker_max_replicas = 2

  db_sku_name              = "GP_Standard_D2ds_v5"
  db_storage_mb            = 131072
  db_ha_mode               = "ZoneRedundant"
  db_read_replica_count    = 0
  db_backup_retention_days = 14
  db_geo_redundant_backup  = false

  redis_sku_name      = "Balanced_B3"
  redis_ha            = true
  servicebus_sku      = "Standard"
  servicebus_capacity = 0
  zone_redundant      = true
}
