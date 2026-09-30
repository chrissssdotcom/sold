terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
  }
}

# One Container Apps environment (workload-profiles type; the Consumption-only type is legacy),
# a `web` app (external ingress, HTTP autoscaling, scale-to-zero capable), a `worker` app
# (no ingress; queue/CPU scaling) and a manual `migrate` job. One image, three roles (ADR-0001 rule 5).
# Names are short because every environment has its own resource group.

variable "name" {
  description = "Environment name prefix (env-id)."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "infrastructure_subnet_id" {
  type = string
}

variable "infrastructure_resource_group_name" {
  description = "Resource group Azure creates for the environment's managed infrastructure. Deleted with the environment."
  type        = string
}

variable "log_analytics_workspace_id" {
  type = string
}

variable "identity_id" {
  description = "User-assigned identity used for image pull, Key Vault references and data-plane auth."
  type        = string
}

variable "identity_client_id" {
  type = string
}

variable "registry_server" {
  description = "Login server of the registry, e.g. acrdemo.azurecr.io. The identity needs AcrPull (composite grants it)."
  type        = string
}

variable "image" {
  description = "Web image, repository@sha256:digest. Build once, promote the same digest (AGENTS.md principle 9). The Dockerfile has separate web/worker targets, so the worker (and migrate job) may use their own images."
  type        = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "image must be pinned by digest (repository@sha256:<64 hex>). Tags are mutable and are not promoted."
  }
}

variable "worker_image" {
  description = "Worker image (Dockerfile target `worker`). Null = same as `image`."
  type        = string
  default     = null
  validation {
    condition     = var.worker_image == null || can(regex("@sha256:[a-f0-9]{64}$", var.worker_image))
    error_message = "worker_image must be pinned by digest."
  }
}

variable "migrate_image" {
  description = "Image able to run migrations (needs a migrate entrypoint: PENDING(phase-0) Dockerfile target). Null = same as `image`."
  type        = string
  default     = null
  validation {
    condition     = var.migrate_image == null || can(regex("@sha256:[a-f0-9]{64}$", var.migrate_image))
    error_message = "migrate_image must be pinned by digest."
  }
}

variable "app_env" {
  description = "Plain (non-secret) environment variables shared by web, worker and migrate."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Environment variable name => Key Vault secret URI (versionless). Resolved by the platform with the identity; values never appear in Terraform state."
  type        = map(string)
  default     = {}
}

variable "web" {
  type = object({
    cpu          = number
    memory       = string
    min_replicas = number
    max_replicas = number
    concurrency  = number # HTTP scale rule: concurrent requests per replica
    port         = number
  })
}

variable "worker" {
  type = object({
    cpu          = number
    memory       = string
    min_replicas = number
    max_replicas = number
  })
}

variable "migrate_command" {
  description = "Command override for the migrate job. Null = the image's own ENTRYPOINT/CMD (the migrate image bundles the migrator like the worker bundle does)."
  type        = list(string)
  default     = null
}

variable "workload_profile" {
  description = "Optional dedicated profile (e.g. D4) for high-volume / event-scale tiers. Null = serverless Consumption only."
  type = object({
    name          = string
    type          = string
    minimum_count = number
    maximum_count = number
  })
  default = null
}

variable "zone_redundancy_enabled" {
  type    = bool
  default = false
}

variable "revision_mode" {
  description = "Single (dev/ephemeral) or Multiple (stage/prod: canary via traffic splitting)."
  type        = string
  default     = "Single"
  validation {
    condition     = contains(["Single", "Multiple"], var.revision_mode)
    error_message = "revision_mode must be Single or Multiple."
  }
}

variable "revision_suffix" {
  description = "Name of the revision this apply creates, derived from the release (e.g. b27). Required in Multiple mode."
  type        = string
  default     = null
  validation {
    condition     = var.revision_suffix == null || can(regex("^[a-z0-9][a-z0-9-]{0,20}$", var.revision_suffix))
    error_message = "revision_suffix must be lowercase alphanumerics/hyphens, max 21 chars."
  }
}

variable "previous_revision_suffix" {
  description = "Revision that keeps the remainder of traffic during a canary."
  type        = string
  default     = null
}

variable "canary_percent" {
  description = "Share of traffic to the new revision (0-100). 100 = fully promoted. The release pipeline drives 0 -> 10 -> 50 -> 100."
  type        = number
  default     = 100
  validation {
    condition     = var.canary_percent >= 0 && var.canary_percent <= 100
    error_message = "canary_percent must be 0-100."
  }
}

variable "paused" {
  description = "Scale web and worker to zero (env:pause). PostgreSQL is stopped out-of-band by the CLI; Managed Redis cannot be stopped."
  type        = bool
  default     = false
}

variable "ingress_allowed_cidrs" {
  description = "When non-empty, only these CIDRs (Cloudflare ranges) may reach the web ingress. Empty = unrestricted (ephemeral without Cloudflare)."
  type        = list(string)
  default     = []
}

variable "custom_domain_enabled" {
  description = "Bind the environment hostname to the web app with an uploaded (Cloudflare Origin CA) certificate. Static so `count` is known at plan time."
  type        = bool
  default     = false
}

variable "custom_domain_hostname" {
  description = "Hostname to bind. Pass the cloudflare-edge asuid_hostname output so the binding is ordered after the verification TXT record exists."
  type        = string
  default     = null
}

variable "custom_domain_certificate_secret_id" {
  description = "Key Vault secret ID (versionless) holding certificate + private key as PEM (content type application/x-pem-file). The identity needs Key Vault Secrets User. PEM handling by Container Apps is UNVERIFIED until first apply (ADR-0002)."
  type        = string
  default     = null
}

variable "servicebus_worker_scaling" {
  description = "KEDA azure-servicebus rule for the worker. Null = CPU scaling only."
  type = object({
    namespace_fqdn = string
    queue_name     = string
    message_count  = number
  })
  default = null
}

variable "tags" {
  type = map(string)
  validation {
    condition = alltrue([
      for t in ["sold:customer", "sold:environment", "sold:profile", "sold:owner", "sold:expires-at", "sold:release", "sold:env-id"] :
      contains(keys(var.tags), t) && try(length(var.tags[t]) > 0, false)
    ])
    error_message = "tags must include non-empty sold:customer, sold:environment, sold:profile, sold:owner, sold:expires-at, sold:release and sold:env-id."
  }
}

locals {
  multiple = var.revision_mode == "Multiple"

  canary_active = local.multiple && var.canary_percent < 100 && var.previous_revision_suffix != null && var.revision_suffix != null

  traffic = local.canary_active ? [
    { latest_revision = false, revision_suffix = var.revision_suffix, percentage = var.canary_percent },
    { latest_revision = false, revision_suffix = var.previous_revision_suffix, percentage = 100 - var.canary_percent },
    ] : (local.multiple && var.revision_suffix != null ? [
      { latest_revision = false, revision_suffix = var.revision_suffix, percentage = 100 },
      ] : [
      { latest_revision = true, revision_suffix = null, percentage = 100 },
  ])

  web_min    = var.paused ? 0 : var.web.min_replicas
  worker_min = var.paused ? 0 : var.worker.min_replicas

  profile_name = var.workload_profile == null ? "Consumption" : var.workload_profile.name

  secret_names = { for k, _ in var.secret_env : k => lower(replace(k, "_", "-")) }
}

resource "azurerm_container_app_environment" "this" {
  name                               = "cae-${var.name}"
  location                           = var.location
  resource_group_name                = var.resource_group_name
  infrastructure_subnet_id           = var.infrastructure_subnet_id
  infrastructure_resource_group_name = var.infrastructure_resource_group_name
  logs_destination                   = "log-analytics"
  log_analytics_workspace_id         = var.log_analytics_workspace_id
  zone_redundancy_enabled            = var.zone_redundancy_enabled
  tags                               = var.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  dynamic "workload_profile" {
    for_each = var.workload_profile == null ? [] : [var.workload_profile]
    content {
      name                  = workload_profile.value.name
      workload_profile_type = workload_profile.value.type
      minimum_count         = workload_profile.value.minimum_count
      maximum_count         = workload_profile.value.maximum_count
    }
  }
}

resource "azurerm_container_app" "web" {
  name                         = "web"
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = var.revision_mode
  workload_profile_name        = local.profile_name
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  registry {
    server   = var.registry_server
    identity = var.identity_id
  }

  dynamic "secret" {
    for_each = var.secret_env
    content {
      name                = local.secret_names[secret.key]
      identity            = var.identity_id
      key_vault_secret_id = secret.value
    }
  }

  ingress {
    external_enabled           = true
    target_port                = var.web.port
    transport                  = "auto"
    allow_insecure_connections = false

    dynamic "traffic_weight" {
      for_each = local.traffic
      content {
        latest_revision = traffic_weight.value.latest_revision
        revision_suffix = traffic_weight.value.revision_suffix
        percentage      = traffic_weight.value.percentage
      }
    }

    dynamic "ip_security_restriction" {
      for_each = { for i, c in var.ingress_allowed_cidrs : format("cf-%02d", i) => c }
      content {
        name             = ip_security_restriction.key
        action           = "Allow"
        ip_address_range = ip_security_restriction.value
        description      = "Cloudflare edge"
      }
    }
  }

  template {
    min_replicas    = local.web_min
    max_replicas    = var.web.max_replicas
    revision_suffix = var.revision_suffix

    http_scale_rule {
      name                = "http"
      concurrent_requests = tostring(var.web.concurrency)
    }

    container {
      name   = "web"
      image  = var.image
      cpu    = var.web.cpu
      memory = var.web.memory

      env {
        name  = "SOLD_ROLE"
        value = "web"
      }
      env {
        name  = "PORT"
        value = tostring(var.web.port)
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = var.identity_client_id
      }
      dynamic "env" {
        for_each = var.app_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secret_env
        content {
          name        = env.key
          secret_name = local.secret_names[env.key]
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = var.web.port
        path                    = "/api/health/live"
        interval_seconds        = 3
        failure_count_threshold = 30
      }
      liveness_probe {
        transport               = "HTTP"
        port                    = var.web.port
        path                    = "/api/health/live"
        interval_seconds        = 10
        failure_count_threshold = 3
      }
      readiness_probe {
        transport               = "HTTP"
        port                    = var.web.port
        path                    = "/api/health/ready"
        interval_seconds        = 5
        failure_count_threshold = 3
      }
    }
  }
}

resource "azurerm_container_app_environment_certificate" "origin" {
  count = var.custom_domain_enabled ? 1 : 0

  name                         = "origin"
  container_app_environment_id = azurerm_container_app_environment.this.id
  tags                         = var.tags

  certificate_key_vault {
    identity            = var.identity_id
    key_vault_secret_id = var.custom_domain_certificate_secret_id
  }
}

resource "azurerm_container_app_custom_domain" "web" {
  count = var.custom_domain_enabled ? 1 : 0

  name                                     = var.custom_domain_hostname
  container_app_id                         = azurerm_container_app.web.id
  container_app_environment_certificate_id = azurerm_container_app_environment_certificate.origin[0].id
  certificate_binding_type                 = "SniEnabled"
}

resource "azurerm_container_app" "worker" {
  name                         = "worker"
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.this.id
  revision_mode                = "Single"
  workload_profile_name        = local.profile_name
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  registry {
    server   = var.registry_server
    identity = var.identity_id
  }

  dynamic "secret" {
    for_each = var.secret_env
    content {
      name                = local.secret_names[secret.key]
      identity            = var.identity_id
      key_vault_secret_id = secret.value
    }
  }

  template {
    min_replicas = local.worker_min
    max_replicas = var.worker.max_replicas

    custom_scale_rule {
      name             = "cpu"
      custom_rule_type = "cpu"
      metadata = {
        type  = "Utilization"
        value = "70"
      }
    }

    dynamic "custom_scale_rule" {
      for_each = var.servicebus_worker_scaling == null ? [] : [var.servicebus_worker_scaling]
      content {
        name             = "servicebus-${custom_scale_rule.value.queue_name}"
        custom_rule_type = "azure-servicebus"
        identity_id      = var.identity_id
        metadata = {
          namespace    = custom_scale_rule.value.namespace_fqdn
          queueName    = custom_scale_rule.value.queue_name
          messageCount = tostring(custom_scale_rule.value.message_count)
        }
      }
    }

    container {
      name   = "worker"
      image  = coalesce(var.worker_image, var.image)
      cpu    = var.worker.cpu
      memory = var.worker.memory

      env {
        name  = "SOLD_ROLE"
        value = "worker"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = var.identity_client_id
      }
      dynamic "env" {
        for_each = var.app_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secret_env
        content {
          name        = env.key
          secret_name = local.secret_names[env.key]
        }
      }

      # The worker serves /live and /ready on WORKER_PORT (default 3001) for the orchestrator.
      liveness_probe {
        transport               = "HTTP"
        port                    = 3001
        path                    = "/live"
        interval_seconds        = 10
        failure_count_threshold = 3
      }
      readiness_probe {
        transport               = "HTTP"
        port                    = 3001
        path                    = "/ready"
        interval_seconds        = 5
        failure_count_threshold = 3
      }
    }
  }
}

# Forward-only, expand/contract migrations run as a job BEFORE traffic shifts to a new revision.
resource "azurerm_container_app_job" "migrate" {
  name                         = "migrate"
  location                     = var.location
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.this.id
  workload_profile_name        = local.profile_name
  replica_timeout_in_seconds   = 1800
  replica_retry_limit          = 0
  tags                         = var.tags

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity_id]
  }

  registry {
    server   = var.registry_server
    identity = var.identity_id
  }

  dynamic "secret" {
    for_each = var.secret_env
    content {
      name                = local.secret_names[secret.key]
      identity            = var.identity_id
      key_vault_secret_id = secret.value
    }
  }

  template {
    container {
      name    = "migrate"
      image   = coalesce(var.migrate_image, var.image)
      cpu     = 0.5
      memory  = "1Gi"
      command = var.migrate_command

      env {
        name  = "SOLD_ROLE"
        value = "worker"
      }
      env {
        name  = "AZURE_CLIENT_ID"
        value = var.identity_client_id
      }
      dynamic "env" {
        for_each = var.app_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = var.secret_env
        content {
          name        = env.key
          secret_name = local.secret_names[env.key]
        }
      }
    }
  }
}

output "environment_id" {
  value = azurerm_container_app_environment.this.id
}

output "default_domain" {
  value = azurerm_container_app_environment.this.default_domain
}

output "custom_domain_verification_id" {
  description = "Publish as TXT asuid.<hostname> before binding a custom domain."
  value       = azurerm_container_app_environment.this.custom_domain_verification_id
}

output "web_id" {
  value = azurerm_container_app.web.id
}

output "web_fqdn" {
  description = "Ingress FQDN of the web app (origin for Cloudflare)."
  value       = azurerm_container_app.web.ingress[0].fqdn
}

output "worker_id" {
  value = azurerm_container_app.worker.id
}

output "migrate_job_name" {
  value = azurerm_container_app_job.migrate.name
}
