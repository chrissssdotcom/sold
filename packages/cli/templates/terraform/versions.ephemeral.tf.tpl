terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26.0"
    }
  }

  # One state per ephemeral environment: the key is supplied at init time so a single root serves
  # every preview:  terraform init -backend-config="key=ephemeral/<env-id>.tfstate"
  # (`sold env:up` and the env-up workflow do this.) Same customer storage account, Entra-only auth.
  backend "azurerm" {
    use_azuread_auth     = true
    storage_account_name = "{{state_account}}"
    container_name       = "{{state_container}}"
  }
}
