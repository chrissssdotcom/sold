output "env_id" {
  value = var.env_id
}

output "tags" {
  description = "The mandatory tag set applied to every Azure resource."
  value       = local.tags
}

output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "web_fqdn" {
  description = "Container Apps ingress FQDN (origin)."
  value       = module.container_apps.web_fqdn
}

output "url" {
  description = "Public URL when the Cloudflare edge is enabled, else the ingress URL."
  value       = local.use_edge ? local.base_url : "https://${module.container_apps.web_fqdn}"
}

output "migrate_job_name" {
  value = module.container_apps.migrate_job_name
}

output "revision_suffix" {
  description = "Revision created by this apply (Multiple revision mode)."
  value       = local.ps.revision_mode == "Multiple" ? local.revision_suffix : null
}

output "key_vault_name" {
  value = module.keyvault.name
}

output "postgres_server_name" {
  value = module.postgres.server_name
}

output "postgres_fqdn" {
  value = module.postgres.fqdn
}

output "redis_enabled" {
  value = local.use_redis
}

output "service_bus_enabled" {
  value = local.use_bus
}

output "log_analytics_workspace_id" {
  value = module.observability.log_analytics_workspace_id
}
