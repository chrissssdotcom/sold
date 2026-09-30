output "url" {
  value = module.environment.url
}

output "env_id" {
  value = module.environment.env_id
}

output "resource_group_name" {
  value = module.environment.resource_group_name
}

output "migrate_job_name" {
  value = module.environment.migrate_job_name
}

output "postgres_server_name" {
  value = module.environment.postgres_server_name
}

# Everything needed to re-apply this environment (pause, resume, extend, destroy) without the
# original command line: `sold env:*` reads it back with `terraform output -json inputs`.
output "inputs" {
  value = {
    env_id          = var.env_id
    environment     = var.environment
    owner           = var.owner
    expires_at      = var.expires_at
    release_version = var.release_version
    image           = var.image
    worker_image    = var.worker_image
    migrate_image   = var.migrate_image
    cloudflare      = var.cloudflare
  }
}
