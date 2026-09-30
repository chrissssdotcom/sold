terraform {
  required_version = ">= 1.9.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
  }
}

# Customer-level (NOT per-environment): the DNS zone, baseline TLS settings and the zone's
# entry-point rulesets. Cloudflare allows exactly one entry-point ruleset per phase per zone,
# so rate limiting, cache rules and response-header rules live here (applied once from the
# customer bootstrap root) and match generically; per-environment resources (DNS, origin
# certificate, Turnstile, Access, Waiting Room) live in cloudflare-edge / cloudflare-access.
# Provider v5 naming: cloudflare_zone (account = { id }), cloudflare_zone_setting, cloudflare_ruleset
# (rules = [ {...} ] attribute list). See ADR-0002.

variable "account_id" {
  type = string
}

variable "zone_name" {
  description = "Apex domain, e.g. example.com."
  type        = string
}

variable "create_zone" {
  description = "False = look up an existing zone by name instead of creating it."
  type        = bool
  default     = false
}

variable "minimum_tls_version" {
  type    = string
  default = "1.2"
}

variable "production_hostnames" {
  description = "Hostnames that MAY be indexed. Every other host on the zone gets X-Robots-Tag: noindex (non-prod safety switch)."
  type        = list(string)
  default     = []
}

variable "rate_limit" {
  description = "Login/auth rate limit. Free-plan constraints apply (characteristics ip.src + cf.colo.id, 10 s period and mitigation); plan-dependent options are not exposed here."
  type = object({
    enabled             = bool
    requests_per_period = number
  })
  default = {
    enabled             = true
    requests_per_period = 20
  }
}

variable "cache_bypass_prefixes" {
  description = "Path prefixes never cached at the edge (per-user, mutating or admin traffic). Must not be empty."
  type        = list(string)
  default     = ["/api/", "/admin", "/cart", "/checkout", "/account"]
  validation {
    condition     = length(var.cache_bypass_prefixes) > 0
    error_message = "Provide at least one bypass prefix (per-user paths must never be edge-cached)."
  }
}

resource "cloudflare_zone" "this" {
  count = var.create_zone ? 1 : 0

  account = {
    id = var.account_id
  }
  name = var.zone_name
  type = "full"
}

data "cloudflare_zone" "existing" {
  count = var.create_zone ? 0 : 1

  filter = {
    name = var.zone_name
    account = {
      id = var.account_id
    }
  }
}

locals {
  zone_id = var.create_zone ? cloudflare_zone.this[0].id : data.cloudflare_zone.existing[0].zone_id

  # Strict origin certificate validation, HTTPS only, modern TLS.
  zone_settings = {
    ssl                      = "strict"
    always_use_https         = "on"
    min_tls_version          = var.minimum_tls_version
    tls_1_3                  = "zrt"
    automatic_https_rewrites = "on"
  }

  bypass_expression = join(" or ", [for p in var.cache_bypass_prefixes : "starts_with(http.request.uri.path, \"${p}\")"])
  # Both cache rules can match; later rules override earlier ones, so the second rule must exclude the bypass paths.
  respect_expression = "not (${local.bypass_expression})"
  prod_host_list     = join(" ", [for h in var.production_hostnames : "\"${h}\""])
  noindex_expression = length(var.production_hostnames) == 0 ? "true" : "not (http.host in {${local.prod_host_list}})"
}

resource "cloudflare_zone_setting" "this" {
  for_each = local.zone_settings

  zone_id    = local.zone_id
  setting_id = each.key
  value      = each.value
}

# Cache rules: never cache per-user/mutating paths; otherwise honour origin Cache-Control so
# ISR pages (with Cache-Tag headers) are served from the edge during spikes.
resource "cloudflare_ruleset" "cache" {
  zone_id     = local.zone_id
  name        = "sold-cache"
  description = "Managed by Terraform (sold). Bypass dynamic paths; respect origin caching elsewhere."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = [
    {
      ref         = "bypass_dynamic"
      description = "Bypass cache for dynamic paths"
      expression  = local.bypass_expression
      action      = "set_cache_settings"
      action_parameters = {
        cache = false
      }
    },
    {
      ref         = "respect_origin"
      description = "Cache eligible pages using origin headers"
      expression  = local.respect_expression
      action      = "set_cache_settings"
      action_parameters = {
        cache = true
        edge_ttl = {
          mode = "respect_origin"
        }
      }
    },
  ]
}

resource "cloudflare_ruleset" "rate_limit" {
  count = var.rate_limit.enabled ? 1 : 0

  zone_id     = local.zone_id
  name        = "sold-rate-limit"
  description = "Managed by Terraform (sold). Throttle credential endpoints per IP per colo."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [
    {
      ref         = "auth_per_ip"
      description = "Auth endpoints"
      expression  = "starts_with(http.request.uri.path, \"/api/auth/\")"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 10
        requests_per_period = var.rate_limit.requests_per_period
        mitigation_timeout  = 10
      }
    },
  ]
}

# Non-production safety switch: noindex everything that is not a production hostname.
resource "cloudflare_ruleset" "noindex" {
  zone_id     = local.zone_id
  name        = "sold-noindex"
  description = "Managed by Terraform (sold). X-Robots-Tag: noindex on non-production hostnames."
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = [
    {
      ref         = "noindex_non_prod"
      description = "noindex non-production hosts"
      expression  = local.noindex_expression
      action      = "rewrite"
      action_parameters = {
        headers = {
          "X-Robots-Tag" = {
            operation = "set"
            value     = "noindex, nofollow"
          }
        }
      }
    },
  ]
}

output "zone_id" {
  value = local.zone_id
}

output "zone_name" {
  value = var.zone_name
}
