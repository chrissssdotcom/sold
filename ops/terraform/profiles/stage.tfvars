# Profile: stage (production-shaped rehearsal). Capacity comes from a tier file
# (-var-file=profiles/tier-<tier>.tfvars): stage runs the SAME tier as prod so load tests and
# canary rehearsals are meaningful. Redis and private endpoints are ON to match prod.
# Not protected: stage may be torn down and rebuilt, but only by an explicit approved run.

profile_settings = {
  resource_lock          = false
  protect_stateful       = false
  redis_enabled          = true
  service_bus_enabled    = false
  private_endpoints      = true
  revision_mode          = "Multiple"
  postgres_password_auth = true
  generate_app_secrets   = true
  log_retention_days     = 30
  log_daily_quota_gb     = 5
  budget_monthly         = 600
  origin_cert_days       = 365
}
