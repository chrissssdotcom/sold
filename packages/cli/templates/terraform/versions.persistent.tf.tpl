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

  # One state per environment, in the CUSTOMER'S OWN storage account (created by ops/terraform/bootstrap),
  # authenticated with Microsoft Entra ID only (no account keys, no SAS). In CI, ARM_USE_OIDC=true and
  # ARM_CLIENT_ID/ARM_TENANT_ID come from the GitHub OIDC login. Locally, `az login` (use_cli) works.
  # Names below are the {{customer}} customer's; override at init time with -backend-config if they differ.
  backend "azurerm" {
    use_azuread_auth     = true
    storage_account_name = "{{state_account}}"
    container_name       = "{{state_container}}"
    key                  = "{{environment}}.tfstate"
  }
}
