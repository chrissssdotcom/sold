# Customer-specific, NON-SECRET defaults shared by every {{customer}} preview environment.
# Per-environment values (env_id, expires_at, release, hostname) are passed by `sold env:up`.

subscription_id = "00000000-0000-0000-0000-000000000000"
region          = "australiaeast"
owner           = "platform@{{customer}}.example"
alert_emails    = ["platform@{{customer}}.example"]

registry = {
  id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-sold-{{customer}}-shared/providers/Microsoft.ContainerRegistry/registries/{{registry_name}}"
  login_server = "{{registry_name}}.azurecr.io"
}

# Previews get a hostname under the preview zone: <env-id>.preview.{{customer}}.example (passed by env:up as
# -var 'cloudflare={...}'). Access keeps previews private to the team.
cloudflare = {
  enabled = false
}

access = {
  enabled               = true
  allowed_email_domains = ["{{customer}}.example"]
}
