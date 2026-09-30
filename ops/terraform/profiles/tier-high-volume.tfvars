# Tier: high-volume. Dedicated D4 workload profile for predictable performance, one read replica
# (catalog/search/admin lists/reporting), longer PITR, geo-redundant backups.

tier_settings = {
  web_cpu             = 1
  web_memory          = "2Gi"
  web_min_replicas    = 3
  web_max_replicas    = 20
  web_concurrency     = 100
  worker_cpu          = 1
  worker_memory       = "2Gi"
  worker_min_replicas = 2
  worker_max_replicas = 6
  dedicated_profile = {
    name          = "d4"
    type          = "D4"
    minimum_count = 2
    maximum_count = 10
  }

  db_sku_name              = "GP_Standard_D8ds_v5"
  db_storage_mb            = 524288
  db_ha_mode               = "ZoneRedundant"
  db_read_replica_count    = 1
  db_backup_retention_days = 35
  db_geo_redundant_backup  = true

  redis_sku_name      = "Balanced_B10"
  redis_ha            = true
  servicebus_sku      = "Premium"
  servicebus_capacity = 1
  zone_redundant      = true
}
