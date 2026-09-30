# Profile: prod. Change only via the promotion PR (release.json) and the gated `prod` GitHub
# environment. Capacity comes from a tier file (-var-file=profiles/tier-<tier>.tfvars).
# Guardrails: CanNotDelete lock on the resource group, prevent_destroy on PostgreSQL / Key Vault /
# R2 bucket, Key Vault purge protection, SOLD_SECRET_KEY provisioned out of band.

profile_settings = {
  resource_lock          = true
  protect_stateful       = true
  redis_enabled          = true
  service_bus_enabled    = false # enable per customer when the pg-boss thresholds in docs/scaling.md are crossed
  private_endpoints      = true
  revision_mode          = "Multiple"
  postgres_password_auth = true # flip to Entra-only once the DB adapter supports it: PENDING(phase-7)
  generate_app_secrets   = false
  log_retention_days     = 90
  log_daily_quota_gb     = -1 # no cap: never drop production logs to save money
  budget_monthly         = 3000
  origin_cert_days       = 365
}
