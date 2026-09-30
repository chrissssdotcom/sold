# Customer-specific, NON-SECRET settings for {{customer}}/{{environment}}. Replace the placeholder identifiers with the
# values printed by the customer bootstrap (ops/terraform/bootstrap) before the first apply.

subscription_id = "00000000-0000-0000-0000-000000000000"
region          = "australiaeast"
owner           = "platform@{{customer}}.example"
alert_emails    = ["platform@{{customer}}.example"]
{{tier_line}}

registry = {
  id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-sold-{{customer}}-shared/providers/Microsoft.ContainerRegistry/registries/{{registry_name}}"
  login_server = "{{registry_name}}.azurecr.io"
}

cloudflare = {
  enabled    = true
  account_id = "00000000000000000000000000000000"
  zone_id    = "00000000000000000000000000000000"
  hostname   = "{{hostname}}"
}

{{access_block}}
