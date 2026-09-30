terraform {
  required_version = ">= 1.9.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
  }
}

# Cloudflare Access in front of non-production environments (ephemeral, dev, stage previews),
# so unfinished work and test data are never public. Prod normally does not use this module.
# Cloudflare Zero Trust Free supports up to 50 users (verified via published pricing, ADR-0002);
# beyond that seats are billed - keep the allow-list to the people who need it.
# v5 naming: cloudflare_zero_trust_access_policy (account-level, reusable) and
# cloudflare_zero_trust_access_application (policies = [ { id, precedence } ]).

variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "env_id" {
  type = string
}

variable "hostname" {
  type = string
}

variable "allowed_email_domains" {
  description = "Everyone at these domains may enter."
  type        = list(string)
  default     = []
}

variable "allowed_emails" {
  description = "Individual addresses (e.g. external reviewers)."
  type        = list(string)
  default     = []
}

variable "session_duration" {
  type    = string
  default = "8h"
}

variable "bypass_paths" {
  description = "Paths that must stay reachable without login (e.g. payment provider test webhooks). Each is its own Access application with a bypass policy."
  type        = list(string)
  default     = ["/api/webhooks"]
}

locals {
  include_rules = concat(
    [for d in var.allowed_email_domains : { email_domain = { domain = d } }],
    [for e in var.allowed_emails : { email = { email = e } }],
  )
}

resource "cloudflare_zero_trust_access_policy" "allow" {
  account_id       = var.account_id
  name             = "sold-${var.env_id}-allow"
  decision         = "allow"
  session_duration = var.session_duration
  include          = local.include_rules

  lifecycle {
    precondition {
      condition     = length(local.include_rules) > 0
      error_message = "cloudflare-access needs at least one allowed email domain or email; an empty allow-list would lock everyone out."
    }
  }
}

resource "cloudflare_zero_trust_access_policy" "bypass" {
  count = length(var.bypass_paths) > 0 ? 1 : 0

  account_id = var.account_id
  name       = "sold-${var.env_id}-bypass"
  decision   = "bypass"
  include    = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "site" {
  zone_id          = var.zone_id
  name             = "sold-${var.env_id}"
  domain           = var.hostname
  type             = "self_hosted"
  session_duration = var.session_duration
  policies = [{
    id         = cloudflare_zero_trust_access_policy.allow.id
    precedence = 1
  }]
}

resource "cloudflare_zero_trust_access_application" "bypass" {
  for_each = length(var.bypass_paths) > 0 ? toset(var.bypass_paths) : toset([])

  zone_id = var.zone_id
  name    = "sold-${var.env_id}-bypass-${trim(replace(each.value, "/", "-"), "-")}"
  domain  = "${var.hostname}${each.value}"
  type    = "self_hosted"
  policies = [{
    id         = cloudflare_zero_trust_access_policy.bypass[0].id
    precedence = 1
  }]
}

output "application_id" {
  value = cloudflare_zero_trust_access_application.site.id
}
