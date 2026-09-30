# Tier: event-scale (flash sales, TikTok drops). Applied ahead of a scheduled event together with
# SOLD_SCALE_MODE=prescale and the Cloudflare Waiting Room (Business/Enterprise plans only).
# Memory Optimized PostgreSQL, two read replicas, large dedicated profile with a high floor.

tier_settings = {
  web_cpu             = 1
  web_memory          = "2Gi"
  web_min_replicas    = 6
  web_max_replicas    = 100
  web_concurrency     = 100
  worker_cpu          = 1
  worker_memory       = "2Gi"
  worker_min_replicas = 4
  worker_max_replicas = 20
  dedicated_profile = {
    name          = "d8"
    type          = "D8"
    minimum_count = 4
    maximum_count = 20
  }

  db_sku_name              = "MO_Standard_E16ds_v5"
  db_storage_mb            = 1048576
  db_ha_mode               = "ZoneRedundant"
  db_read_replica_count    = 2
  db_backup_retention_days = 35
  db_geo_redundant_backup  = true

  redis_sku_name      = "Balanced_B50"
  redis_ha            = true
  servicebus_sku      = "Premium"
  servicebus_capacity = 4
  zone_redundant      = true
}
