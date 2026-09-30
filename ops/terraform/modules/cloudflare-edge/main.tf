terraform {
  required_version = ">= 1.9.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.4"
    }
  }
}

# Per-environment edge: proxied DNS, origin certificate, Turnstile widget, optional Waiting Room.
#
# Why an origin certificate: Azure Container Apps routes by Host header, and its free managed
# certificates cannot be issued/renewed behind a Cloudflare proxy (Microsoft docs: mapping to an
# intermediate CNAME such as Cloudflare blocks issuance and renewal). So Cloudflare talks to the
# app on the environment's real hostname using a Cloudflare Origin CA certificate that is bound
# to the app as a custom domain (Full (strict) mode). See ADR-0002.

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
  description = "Fully-qualified hostname for this environment, inside the zone."
  type        = string
}

variable "origin_fqdn" {
  description = "Ingress FQDN of the web app (target of the proxied CNAME)."
  type        = string
}

variable "custom_domain_verification_id" {
  description = "Container Apps environment domain verification ID (published as asuid.<hostname> TXT)."
  type        = string
}

variable "origin_certificate_validity_days" {
  description = "Cloudflare Origin CA validity in days. The set 7, 30, 90, 365, 730, 1095, 5475 is what the Cloudflare API is believed to accept (the provider docs only say \"number of days\"): UNVERIFIED, see ADR-0002."
  type        = number
  default     = 365
  validation {
    condition     = contains([7, 30, 90, 365, 730, 1095, 5475], var.origin_certificate_validity_days)
    error_message = "origin_certificate_validity_days must be one of 7, 30, 90, 365, 730, 1095, 5475."
  }
}

variable "turnstile" {
  description = "Bot challenge widget for checkout/login/forms. Free plan: up to 20 widgets per account, 10 hostnames per widget."
  type = object({
    enabled = bool
    mode    = optional(string, "managed")
  })
  default = { enabled = true }
}

variable "waiting_room" {
  description = "Cloudflare Waiting Room. Business/Enterprise plans only (verified, ADR-0002); scheduled events need the Enterprise advanced add-on."
  type = object({
    enabled              = bool
    path                 = optional(string, "/checkout")
    new_users_per_minute = optional(number, 200)
    total_active_users   = optional(number, 200)
  })
  default = { enabled = false }
}

resource "tls_private_key" "origin" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  dns_names       = [var.hostname]

  subject {
    common_name = var.hostname
  }
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = [var.hostname]
  request_type       = "origin-rsa"
  requested_validity = var.origin_certificate_validity_days
}

# Domain ownership for the Container Apps custom-domain binding.
resource "cloudflare_dns_record" "asuid" {
  zone_id = var.zone_id
  name    = "asuid.${var.hostname}"
  type    = "TXT"
  content = var.custom_domain_verification_id
  ttl     = 1
  proxied = false
  comment = "sold:env-id=${var.env_id} (Container Apps domain verification)"
}

resource "cloudflare_dns_record" "origin" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = var.origin_fqdn
  ttl     = 1
  proxied = true
  comment = "sold:env-id=${var.env_id}"
}

resource "cloudflare_turnstile_widget" "this" {
  count = var.turnstile.enabled ? 1 : 0

  account_id = var.account_id
  name       = "sold-${var.env_id}"
  domains    = [var.hostname]
  mode       = var.turnstile.mode
}

resource "cloudflare_waiting_room" "this" {
  count = var.waiting_room.enabled ? 1 : 0

  zone_id              = var.zone_id
  name                 = "sold-${var.env_id}"
  host                 = var.hostname
  path                 = var.waiting_room.path
  new_users_per_minute = var.waiting_room.new_users_per_minute
  total_active_users   = var.waiting_room.total_active_users
  queueing_method      = "fifo"
  description          = "sold:env-id=${var.env_id}"
}

output "origin_certificate_bundle_pem" {
  description = "Certificate followed by private key (PEM). Feed to the Container Apps environment certificate; never printed."
  value       = "${cloudflare_origin_ca_certificate.origin.certificate}\n${tls_private_key.origin.private_key_pem}"
  sensitive   = true
}

output "asuid_hostname" {
  description = "Hostname of the verification record; consuming it orders the custom-domain binding after the TXT record exists."
  value       = trimprefix(cloudflare_dns_record.asuid.name, "asuid.")
}

output "hostname" {
  value = var.hostname
}

output "turnstile_site_key" {
  value = one(cloudflare_turnstile_widget.this[*].sitekey)
}

output "turnstile_secret" {
  value     = one(cloudflare_turnstile_widget.this[*].secret)
  sensitive = true
}
