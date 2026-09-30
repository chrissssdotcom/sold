terraform {
  required_version = ">= 1.9.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
  }
}

variable "name" {
  description = "Name prefix (env-id)."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "resource_group_id" {
  type = string
}

variable "log_retention_days" {
  description = "Log Analytics retention. 30 is the free-included period; longer costs money."
  type        = number
  default     = 30
  validation {
    condition     = var.log_retention_days >= 30 && var.log_retention_days <= 730
    error_message = "log_retention_days must be between 30 and 730."
  }
}

variable "daily_quota_gb" {
  description = "Hard daily ingestion cap (cost guardrail). -1 disables the cap."
  type        = number
  default     = 1
}

variable "alert_emails" {
  description = "Owner / on-call addresses for alerts and budget notifications."
  type        = list(string)
  validation {
    condition     = length(var.alert_emails) > 0
    error_message = "At least one alert email is required so budgets and alerts always reach someone."
  }
}

variable "budget" {
  description = "Monthly budget in the subscription's billing currency. Notifications at 50/80/100% actual and 100% forecast."
  type = object({
    amount     = number
    start_date = optional(string) # RFC3339, first day of a month. Defaults to the current month on first apply.
  })
}

variable "alert_targets" {
  description = "Resources to alert on. The *_enabled flags are static so `count` is known at plan time (ids are only known after apply)."
  type = object({
    web_enabled      = optional(bool, false)
    web_app_id       = optional(string)
    postgres_enabled = optional(bool, false)
    postgres_id      = optional(string)
    web_5xx_per_5m   = optional(number, 25)
    postgres_cpu_pc  = optional(number, 85)
  })
  default = {}
}

variable "tags" {
  type = map(string)
  validation {
    condition = alltrue([
      for t in ["sold:customer", "sold:environment", "sold:profile", "sold:owner", "sold:expires-at", "sold:release", "sold:env-id"] :
      contains(keys(var.tags), t) && try(length(var.tags[t]) > 0, false)
    ])
    error_message = "tags must include non-empty sold:customer, sold:environment, sold:profile, sold:owner, sold:expires-at, sold:release and sold:env-id."
  }
}

locals {
  budget_start = coalesce(var.budget.start_date, formatdate("YYYY-MM-01'T'00:00:00'Z'", timestamp()))
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  daily_quota_gb      = var.daily_quota_gb
  tags                = var.tags
}

resource "azurerm_application_insights" "this" {
  name                = "appi-${var.name}"
  location            = var.location
  resource_group_name = var.resource_group_name
  workspace_id        = azurerm_log_analytics_workspace.this.id
  application_type    = "web"
  tags                = var.tags
}

resource "azurerm_monitor_action_group" "owners" {
  name                = "ag-${var.name}"
  resource_group_name = var.resource_group_name
  short_name          = substr(replace(var.name, "-", ""), 0, 12)
  tags                = var.tags

  dynamic "email_receiver" {
    for_each = { for i, e in var.alert_emails : tostring(i) => e }
    content {
      name                    = "owner-${email_receiver.key}"
      email_address           = email_receiver.value
      use_common_alert_schema = true
    }
  }
}

resource "azurerm_monitor_metric_alert" "web_5xx" {
  count = var.alert_targets.web_enabled ? 1 : 0

  name                = "alert-${var.name}-web-5xx"
  resource_group_name = var.resource_group_name
  scopes              = [var.alert_targets.web_app_id]
  description         = "Web 5xx responses above threshold over 5 minutes."
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"
  tags                = var.tags

  criteria {
    metric_namespace = "microsoft.app/containerapps"
    metric_name      = "Requests"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = var.alert_targets.web_5xx_per_5m

    dimension {
      name     = "statusCodeCategory"
      operator = "Include"
      values   = ["5xx"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.owners.id
  }
}

resource "azurerm_monitor_metric_alert" "postgres_cpu" {
  count = var.alert_targets.postgres_enabled ? 1 : 0

  name                = "alert-${var.name}-postgres-cpu"
  resource_group_name = var.resource_group_name
  scopes              = [var.alert_targets.postgres_id]
  description         = "PostgreSQL CPU above threshold for 15 minutes."
  severity            = 2
  frequency           = "PT5M"
  window_size         = "PT15M"
  tags                = var.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "cpu_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = var.alert_targets.postgres_cpu_pc
  }

  action {
    action_group_id = azurerm_monitor_action_group.owners.id
  }
}

resource "azurerm_consumption_budget_resource_group" "this" {
  name              = "budget-${var.name}"
  resource_group_id = var.resource_group_id
  amount            = var.budget.amount
  time_grain        = "Monthly"

  time_period {
    start_date = local.budget_start
  }

  dynamic "notification" {
    for_each = {
      actual_50    = { threshold = 50, type = "Actual" }
      actual_80    = { threshold = 80, type = "Actual" }
      actual_100   = { threshold = 100, type = "Actual" }
      forecast_100 = { threshold = 100, type = "Forecasted" }
    }
    content {
      enabled        = true
      operator       = "GreaterThan"
      threshold      = notification.value.threshold
      threshold_type = notification.value.type
      contact_emails = var.alert_emails
      contact_groups = [azurerm_monitor_action_group.owners.id]
    }
  }

  lifecycle {
    # start_date defaults to timestamp(); do not churn the budget every month.
    ignore_changes = [time_period]
  }
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.this.id
}

output "application_insights_connection_string" {
  value     = azurerm_application_insights.this.connection_string
  sensitive = true
}

output "action_group_id" {
  value = azurerm_monitor_action_group.owners.id
}
