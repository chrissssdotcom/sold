# Canary / revision logic. Offline (mock provider):  terraform test   (or: tofu test)

mock_provider "azurerm" {
  mock_resource "azurerm_container_app_environment" {
    defaults = {
      id = "/subscriptions/22222222-2222-2222-2222-222222222222/resourceGroups/rg-mock/providers/Microsoft.App/managedEnvironments/cae-mock"
    }
  }
}

variables {
  name                               = "demo-prod"
  location                           = "australiaeast"
  resource_group_name                = "rg-sold-demo-prod"
  infrastructure_subnet_id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/s"
  infrastructure_resource_group_name = "rg-sold-demo-prod-aca"
  log_analytics_workspace_id         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.OperationalInsights/workspaces/w"
  identity_id                        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/i"
  identity_client_id                 = "66666666-6666-6666-6666-666666666666"
  registry_server                    = "acrsolddemo.azurecr.io"
  image                              = "acrsolddemo.azurecr.io/sold/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  web = {
    cpu          = 1
    memory       = "2Gi"
    min_replicas = 2
    max_replicas = 20
    concurrency  = 100
    port         = 3000
  }
  worker = {
    cpu          = 0.5
    memory       = "1Gi"
    min_replicas = 1
    max_replicas = 5
  }
  tags = {
    "sold:customer"    = "demo"
    "sold:environment" = "prod"
    "sold:profile"     = "prod"
    "sold:owner"       = "platform"
    "sold:expires-at"  = "never"
    "sold:release"     = "1.4.0+demo.27"
    "sold:env-id"      = "demo-prod"
  }
}

run "single_mode_routes_all_traffic_to_latest" {
  command = plan

  assert {
    condition     = length(azurerm_container_app.web.ingress[0].traffic_weight) == 1 && azurerm_container_app.web.ingress[0].traffic_weight[0].latest_revision == true
    error_message = "single revision mode must send 100% to the latest revision"
  }
}

run "multiple_mode_canary_splits_between_new_and_previous" {
  command = plan

  variables {
    revision_mode            = "Multiple"
    revision_suffix          = "b27"
    previous_revision_suffix = "b26"
    canary_percent           = 10
  }

  assert {
    condition     = length(azurerm_container_app.web.ingress[0].traffic_weight) == 2
    error_message = "a canary must produce two traffic weights"
  }
  assert {
    condition     = sum([for t in azurerm_container_app.web.ingress[0].traffic_weight : t.percentage]) == 100
    error_message = "traffic weights must sum to 100"
  }
  assert {
    condition     = [for t in azurerm_container_app.web.ingress[0].traffic_weight : t.percentage if t.revision_suffix == "b27"][0] == 10
    error_message = "the new revision must receive canary_percent"
  }
}

run "multiple_mode_fully_promoted_sends_everything_to_new_revision" {
  command = plan

  variables {
    revision_mode            = "Multiple"
    revision_suffix          = "b27"
    previous_revision_suffix = "b26"
    canary_percent           = 100
  }

  assert {
    condition     = length(azurerm_container_app.web.ingress[0].traffic_weight) == 1 && azurerm_container_app.web.ingress[0].traffic_weight[0].revision_suffix == "b27"
    error_message = "promotion must route 100% to the new revision"
  }
}

run "pause_scales_to_zero" {
  command = plan

  variables {
    paused = true
  }

  assert {
    condition     = azurerm_container_app.web.template[0].min_replicas == 0 && azurerm_container_app.worker.template[0].min_replicas == 0
    error_message = "env:pause must scale web and worker to zero"
  }
}

run "image_must_be_digest_pinned" {
  command = plan

  variables {
    image = "acrsolddemo.azurecr.io/sold/app:latest"
  }

  expect_failures = [var.image]
}
