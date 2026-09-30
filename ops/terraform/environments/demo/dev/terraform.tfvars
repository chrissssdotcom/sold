# Customer-specific, NON-SECRET settings for demo/dev. Replace the placeholder identifiers with the
# values printed by the customer bootstrap (ops/terraform/bootstrap) before the first apply.

subscription_id = "00000000-0000-0000-0000-000000000000"
region          = "australiaeast"
owner           = "platform@demo.example"
alert_emails    = ["platform@demo.example"]

registry = {
  id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-sold-demo-shared/providers/Microsoft.ContainerRegistry/registries/acrsolddemo"
  login_server = "acrsolddemo.azurecr.io"
}

cloudflare = {
  enabled    = true
  account_id = "00000000000000000000000000000000"
  zone_id    = "00000000000000000000000000000000"
  hostname   = "dev.demo.example"
}

access = {
  enabled               = true
  allowed_email_domains = ["demo.example"]
}
