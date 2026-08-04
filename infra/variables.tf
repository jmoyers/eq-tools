# -----------------------------------------------------------------------------
# Inputs.
#
# Anything that would embed an ACCOUNT ID in a committed file has NO default and
# must be passed at apply time (`-var` or a gitignored *.auto.tfvars). This repo
# is public; an account id in git is a free gift to anyone probing.
#
# Every knob that bounds spend is a variable so a flood can be answered by an
# apply instead of an edit — but the defaults are the designed values and should
# not be raised casually.
# -----------------------------------------------------------------------------

variable "region" {
  description = "AWS region for every resource in this root. Owner decision: us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for physical names shared with future roots (web, auth) in this account."
  type        = string
  default     = "eqcompanion"
}

variable "alarm_email" {
  description = "Address subscribed to the ops SNS topic. AWS sends a confirmation mail once."
  type        = string
  default     = "jmoyers+eqc@gmail.com"
}

variable "triage_principal_arn" {
  description = "IAM principal (user or role ARN) allowed to assume the triage role. NO DEFAULT: it contains the account id, which must never be committed."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:(root$|user/|role/)", var.triage_principal_arn))
    error_message = "triage_principal_arn must be an IAM principal ARN: arn:aws:iam::<account>:root|user/<name>|role/<name>."
  }
}

variable "monthly_budget_usd" {
  description = "AWS Budgets monthly cost limit for the account. Notifications at 50/80/100% go to the ops topic."
  type        = number
  default     = 10
}

variable "lambda_reserved_concurrency" {
  description = "The hard blast-radius cap. Bounds spend even if every throttle above it is misconfigured. -1 (UNRESERVED) is the default for the same reason as the telemetry function's: the sub-account's total limit of 10 makes ANY reservation illegal ('below minimum unreserved' — measured, 2026-08-04 apply). Set back to 5 once the account quota is raised."
  type        = number
  default     = -1
}

variable "api_rate_limit" {
  description = "Stage-wide steady-state request rate (rps) across every route on this API."
  type        = number
  default     = 5
}

variable "api_burst_limit" {
  description = "Stage-wide burst capacity."
  type        = number
  default     = 10
}

variable "route_rate_limit" {
  description = "Steady-state rate (rps) for POST /v1/feedback specifically."
  type        = number
  default     = 2
}

variable "route_burst_limit" {
  description = "Burst capacity for POST /v1/feedback specifically."
  type        = number
  default     = 5
}

variable "log_retention_days" {
  description = "CloudWatch retention for the Lambda log group AND the API access log group. Access logs carry source IPs, so this doubles as a PII retention bound (incident-only evidence)."
  type        = number
  default     = 14
}

variable "log_object_expiration_days" {
  description = "S3 lifecycle expiry for uploaded log slices under logs/."
  type        = number
  default     = 90
}

variable "dsql_dpu_alarm_threshold" {
  description = "Aurora DSQL TotalDPU (Sum) over 5 minutes that trips the ops alarm. 200 is ~17x the free tier's average burn rate and lands under the monthly budget if sustained — it fires before the bill does, not after."
  type        = number
  default     = 200
}

variable "default_max_reports_per_day" {
  description = "Fallback per-install daily quota used when the feedback_config row does not override it. That row is the live control; this is only the cold-start default."
  type        = number
  default     = 10
}

# ---- usage analytics ingest (docs/plans/usage-analytics.md A2) ---------------

variable "telemetry_reserved_concurrency" {
  description = "Reserved concurrency for the telemetry ingest function. -1 means UNRESERVED, which is the default for a reason: a fresh sub-account's total limit is 10, and reserving from it made the feedback function's own reservation illegal ('below minimum unreserved'). Set a real number once the account's quota is raised."
  type        = number
  default     = -1
}

variable "telemetry_route_rate_limit" {
  description = "Steady-state rate (rps) for POST /v1/telemetry. Wider than feedback's because every install is a caller on a 60s flush timer, not a human pressing a button."
  type        = number
  default     = 10
}

variable "telemetry_route_burst_limit" {
  description = "Burst capacity for POST /v1/telemetry."
  type        = number
  default     = 20
}

variable "default_max_events_per_id_per_day" {
  description = "Fallback per-analyticsId daily EVENT cap, used when the feedback_config column is NULL. The column is the live control (deploy-free); this is the cold-start default. 20,000 is ~14 events/minute sustained for 24h — far past a real install's flush loop."
  type        = number
  default     = 20000
}
