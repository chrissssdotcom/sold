terraform {
  required_version = ">= 1.9.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
  }
}

# Sender authentication DNS for transactional email (SPF, DKIM, DMARC).
#
# Default (mode "smtp"): records for whichever SMTP provider the customer chose, consumed by the
# app through the EmailTransport interface. Cloudflare Email Service "Email Sending" is Beta
# (ADR-0002), so it is opt-in (`cloudflare_email_sending = true`) and never the only option.

variable "zone_id" {
  type = string
}

variable "env_id" {
  type = string
}

variable "sending_domain" {
  description = "Domain or subdomain mail is sent from, e.g. mail.example.com. Use a dedicated subdomain so marketing reputation cannot affect transactional mail."
  type        = string
}

variable "spf_includes" {
  description = "SPF include: mechanisms of the SMTP provider, e.g. [\"spf.provider.example\"]. Empty = do not create an SPF record here."
  type        = list(string)
  default     = []
}

variable "dkim_records" {
  description = "DKIM records supplied by the provider, keyed by label. type is TXT or CNAME."
  type = map(object({
    name    = string
    type    = string
    content = string
  }))
  default = {}
  validation {
    condition     = alltrue([for r in values(var.dkim_records) : contains(["TXT", "CNAME"], r.type)])
    error_message = "DKIM records must be TXT or CNAME."
  }
}

variable "dmarc" {
  description = "DMARC policy. Start at none, move to quarantine/reject once reports are clean."
  type = object({
    policy         = string
    report_address = optional(string)
  })
  default = { policy = "none" }
  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc.policy)
    error_message = "dmarc.policy must be none, quarantine or reject."
  }
}

variable "cloudflare_email_sending" {
  description = "Enable Cloudflare Email Sending (Beta) on the sending domain. Requires the Workers Paid plan."
  type        = bool
  default     = false
}

locals {
  spf_value   = "v=spf1 ${join(" ", [for i in var.spf_includes : "include:${i}"])} ~all"
  dmarc_value = var.dmarc.report_address == null ? "v=DMARC1; p=${var.dmarc.policy}" : "v=DMARC1; p=${var.dmarc.policy}; rua=mailto:${var.dmarc.report_address}"
}

resource "cloudflare_dns_record" "spf" {
  count = length(var.spf_includes) > 0 ? 1 : 0

  zone_id = var.zone_id
  name    = var.sending_domain
  type    = "TXT"
  content = local.spf_value
  ttl     = 3600
  comment = "sold:env-id=${var.env_id}"
}

resource "cloudflare_dns_record" "dkim" {
  for_each = var.dkim_records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
  ttl     = 3600
  proxied = false
  comment = "sold:env-id=${var.env_id}"
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${var.sending_domain}"
  type    = "TXT"
  content = local.dmarc_value
  ttl     = 3600
  comment = "sold:env-id=${var.env_id}"
}

# Beta. Cloudflare documents that it configures the sending DNS records (cf-bounce MX/SPF/DKIM)
# when a domain is onboarded; verify they exist after apply (ADR-0002: UNVERIFIED for API-created subdomains).
resource "cloudflare_email_sending_subdomain" "this" {
  count = var.cloudflare_email_sending ? 1 : 0

  zone_id                    = var.zone_id
  name                       = var.sending_domain
  drop_suppressed_recipients = true
}

output "spf_value" {
  value = length(var.spf_includes) > 0 ? local.spf_value : null
}

output "dmarc_value" {
  value = local.dmarc_value
}
